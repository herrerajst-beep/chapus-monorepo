import { Pool } from 'pg';

export async function verifyAndProvisionPostGIS(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Extensiones base
    await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);
    await client.query(`CREATE EXTENSION IF NOT EXISTS "postgis";`);

    // 2. Tipos Enumerados Idempotentes
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE user_role AS ENUM ('CLIENT', 'PROVIDER', 'DUAL', 'ADMIN');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE kyc_status_type AS ENUM ('UNVERIFIED', 'PENDING_VERIFICATION', 'VERIFIED', 'RESTRICTED');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE pricing_type AS ENUM ('FAST_MATCH', 'BIDDING');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE request_status AS ENUM (
          'OPEN', 'AWAITING_PAYMENT', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'DISPUTED', 'CANCELLED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE bid_status AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      DO $$ BEGIN
        CREATE TYPE payment_status AS ENUM ('REQUIRES_CAPTURE', 'ESCROW_HELD', 'RELEASED', 'REFUNDED', 'FAILED');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // 3. Creación Idempotente de Tablas Relacionales y Geoespaciales
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        email VARCHAR(255) UNIQUE,
        phone VARCHAR(50) UNIQUE NOT NULL,
        full_name VARCHAR(150) NOT NULL DEFAULT 'Usuario Chapus',
        avatar_url TEXT,
        role user_role NOT NULL DEFAULT 'CLIENT',
        kyc_status kyc_status_type NOT NULL DEFAULT 'UNVERIFIED',
        stripe_account_id VARCHAR(120),
        stripe_customer_id VARCHAR(120),
        fcm_token TEXT,
        is_online BOOLEAN NOT NULL DEFAULT FALSE,
        last_location GEOGRAPHY(Point, 4326),
        service_radius_km NUMERIC(5,2) NOT NULL DEFAULT 15.00,
        rating_avg NUMERIC(3,2) NOT NULL DEFAULT 5.00,
        completed_jobs_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS service_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL,
        allowed_models pricing_type[] NOT NULL DEFAULT '{FAST_MATCH,BIDDING}',
        base_fixed_price_eur NUMERIC(10,2) NOT NULL,
        platform_fee_percent NUMERIC(4,2) NOT NULL DEFAULT 15.00
      );

      CREATE TABLE IF NOT EXISTS provider_services (
        provider_id UUID REFERENCES users(id) ON DELETE CASCADE,
        category_id INT REFERENCES service_categories(id) ON DELETE RESTRICT,
        PRIMARY KEY (provider_id, category_id)
      );

      CREATE TABLE IF NOT EXISTS service_requests (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        client_id UUID NOT NULL REFERENCES users(id),
        assigned_provider_id UUID REFERENCES users(id),
        category_id INT NOT NULL REFERENCES service_categories(id),
        pricing_model pricing_type NOT NULL,
        offered_price NUMERIC(10,2),
        final_agreed_price NUMERIC(10,2),
        location GEOGRAPHY(Point, 4326) NOT NULL,
        address_text TEXT NOT NULL,
        approximate_zone VARCHAR(150) NOT NULL CHECK (length(trim(approximate_zone)) > 0),
        description TEXT NOT NULL,
        photo_urls TEXT[] NOT NULL DEFAULT '{}',
        status request_status NOT NULL DEFAULT 'OPEN',
        version INT NOT NULL DEFAULT 1,
        scheduled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        accepted_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS bids (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
        provider_id UUID NOT NULL REFERENCES users(id),
        amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
        estimated_arrival_minutes INT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        status bid_status NOT NULL DEFAULT 'PENDING',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (request_id, provider_id)
      );

      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        request_id UUID UNIQUE NOT NULL REFERENCES service_requests(id),
        client_id UUID NOT NULL REFERENCES users(id),
        provider_id UUID REFERENCES users(id),
        stripe_payment_intent_id VARCHAR(150) UNIQUE NOT NULL,
        stripe_transfer_id VARCHAR(150),
        total_amount NUMERIC(10,2) NOT NULL,
        platform_fee NUMERIC(10,2) NOT NULL,
        provider_payout NUMERIC(10,2) NOT NULL,
        status payment_status NOT NULL,
        captured_at TIMESTAMPTZ,
        released_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 4. Índices Espaciales GIST y Compuestos (Ahora garantizados porque las tablas existen)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_location_online
        ON users USING GIST (last_location)
        WHERE role IN ('PROVIDER', 'DUAL') AND is_online = TRUE;

      CREATE INDEX IF NOT EXISTS idx_requests_location_open
        ON service_requests USING GIST (location)
        WHERE status = 'OPEN';

      CREATE INDEX IF NOT EXISTS idx_requests_status_model
        ON service_requests (status, pricing_model);

      CREATE INDEX IF NOT EXISTS idx_bids_request_status
        ON bids (request_id, status);
    `);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Database] Fallo fatal al aprovisionar esquema PostGIS:', error);
    throw error;
  } finally {
    client.release();
  }
}
