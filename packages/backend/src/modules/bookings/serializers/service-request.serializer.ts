export type BookingStatus =
  | 'OPEN'
  | 'AWAITING_PAYMENT'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'DISPUTED'
  | 'CANCELLED';

export interface ServiceRequestRow {
  id: string;
  client_id: string;
  assigned_provider_id: string | null;
  category_id: number;
  pricing_model: 'FAST_MATCH' | 'BIDDING';
  offered_price: string | number | null;
  final_agreed_price: string | number | null;
  lat: number;
  lng: number;
  address_text: string;
  approximate_zone: string;
  description: string;
  photo_urls: string[] | null;
  status: BookingStatus;
  bids_count: number;
  version: number;
  scheduled_at: Date | string | null;
  created_at: Date | string;
  accepted_at: Date | string | null;
  completed_at: Date | string | null;
  distance_km?: number;
}

export interface ServiceRequestDTO {
  id: string;
  clientId: string;
  assignedProviderId: string | null;
  categoryId: number;
  pricingModel: 'FAST_MATCH' | 'BIDDING';
  offeredPriceEur: number | null;
  finalAgreedPriceEur: number | null;
  location: { lat: number; lng: number };
  addressText: string | null;
  approximateZone: string;
  isAddressMasked: boolean;
  description: string;
  photoUrls: string[];
  status: BookingStatus;
  bidsCount: number;
  version: number;
  scheduledAt: string | null;
  createdAt: string;
  acceptedAt: string | null;
  completedAt: string | null;
  distanceKm?: number;
}

/**
 * Estados en los que el contrato y el Escrow están constituidos,
 * habilitando legalmente la revelación del domicilio al profesional asignado.
 */
const UNMASKED_ESCROW_STATUSES: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'DISPUTED',
]);

export class ServiceRequestSerializer {
  /**
   * Punto único de salida (Single Exit Point) para serializar entidades de base de datos.
   * Bloquea a nivel de objeto cualquier filtración de address_text o coordenadas exactas.
   */
  public static toDTO(row: ServiceRequestRow, viewerUserId: string): ServiceRequestDTO {
    const isClientOwner = row.client_id === viewerUserId;
    const isAssignedProvider =
      row.assigned_provider_id !== null && row.assigned_provider_id === viewerUserId;

    // 1. Control de Acceso Estricto (ACL): Si ya no está OPEN, un tercero no vinculado recibe excepción
    if (row.status !== 'OPEN' && !isClientOwner && !isAssignedProvider) {
      const error: any = new Error('RGPD_FORBIDDEN: No tienes permiso para acceder a esta reserva.');
      error.statusCode = 403;
      error.errorCode = 'RGPD_ACCESS_DENIED';
      throw error;
    }

    // 2. Evaluación de la condición de revelación de domicilio:
    // Solo el cliente propietario o el profesional adjudicado cuando el estado >= ASSIGNED.
    const canRevealExactLocation =
      isClientOwner || (isAssignedProvider && UNMASKED_ESCROW_STATUSES.has(row.status));

    // 3. Construcción inmutable del DTO con truncamiento criptográfico/espacial si aplica
    const serializedLocation = canRevealExactLocation
      ? { lat: Number(row.lat), lng: Number(row.lng) }
      : {
          // Redondeo a 2 decimales (~1.1 km de resolución) para impedir ingeniería inversa del portal
          lat: Math.round(Number(row.lat) * 100) / 100,
          lng: Math.round(Number(row.lng) * 100) / 100,
        };

    const dto: ServiceRequestDTO = {
      id: row.id,
      clientId: row.client_id,
      assignedProviderId: row.assigned_provider_id,
      categoryId: Number(row.category_id),
      pricingModel: row.pricing_model,
      offeredPriceEur: row.offered_price !== null ? Number(row.offered_price) : null,
      finalAgreedPriceEur: row.final_agreed_price !== null ? Number(row.final_agreed_price) : null,
      location: serializedLocation,
      addressText: canRevealExactLocation ? row.address_text : null,
      approximateZone: row.approximate_zone,
      isAddressMasked: !canRevealExactLocation,
      description: row.description,
      photoUrls: Array.isArray(row.photo_urls) ? row.photo_urls : [],
      status: row.status,
      bidsCount: Number(row.bids_count ?? 0),
      version: Number(row.version),
      scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
      acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
      completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    };

    if (row.distance_km !== undefined) {
      dto.distanceKm = Number(row.distance_km);
    }

    return Object.freeze(dto);
  }
}
