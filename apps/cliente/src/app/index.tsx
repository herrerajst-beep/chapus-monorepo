import { View } from 'react-native';
import { router } from 'expo-router';
import { useCategories } from '@chapus/api';
import { formatEur } from '@chapus/core';
import { Badge, Button, Card, Screen, Text, space } from '@chapus/ui';

export default function CatalogScreen() {
  const categories = useCategories();

  return (
    <Screen>
      <View style={{ gap: space.xs }}>
        <Text variant="title">¿Qué necesitas arreglar?</Text>
        <Text muted>Profesionales verificados cerca de ti, con pago protegido hasta que termine el trabajo.</Text>
      </View>

      {categories.isLoading ? <Text muted>Cargando servicios…</Text> : null}
      {categories.isError ? (
        <Card>
          <Text>No hemos podido cargar el catálogo.</Text>
          <Button variant="outline" label="Reintentar" onPress={() => void categories.refetch()} />
        </Card>
      ) : null}

      {categories.data?.map((c) => (
        <Card key={c.id} onPress={() => router.push({ pathname: '/request/new', params: { categoryId: String(c.id) } })}>
          <Text variant="heading">{c.name}</Text>
          <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
            {c.allowedModels.includes('FAST_MATCH') ? (
              <Badge tone="brand" label={`Precio cerrado desde ${formatEur(c.baseFixedPriceEur)}`} />
            ) : null}
            {c.allowedModels.includes('BIDDING') ? <Badge label="Pide presupuesto" /> : null}
          </View>
        </Card>
      ))}
    </Screen>
  );
}
