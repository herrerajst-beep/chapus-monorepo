import { useEffect, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { useCategories, useCreateRequest } from '@chapus/api';
import {
  fieldErrors,
  formatEur,
  serviceRequestSchema,
  type CheckoutResponse,
  type GeoPoint,
  type PricingModel,
} from '@chapus/core';
import { Button, Card, Field, Price, Screen, Segmented, Text, palette, radius, space } from '@chapus/ui';
import { uploadPhotos, type LocalPhoto } from '@/lib/uploads';
import { payWithSheet } from '@/lib/payments';

const MAX_PHOTOS = 6;

export default function NewRequestScreen() {
  const { categoryId } = useLocalSearchParams<{ categoryId: string }>();
  const category = useCategories().data?.find((c) => c.id === Number(categoryId));
  const createRequest = useCreateRequest();

  const [model, setModel] = useState<PricingModel>('FAST_MATCH');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [location, setLocation] = useState<GeoPoint | null>(null);
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [step, setStep] = useState<'idle' | 'uploading' | 'creating' | 'paying'>('idle');
  const [checkout, setCheckout] = useState<CheckoutResponse | null>(null);

  useEffect(() => {
    if (category && !category.allowedModels.includes('FAST_MATCH')) setModel('BIDDING');
  }, [category]);

  // Ubicación + dirección sugerida (el usuario puede corregir piso/puerta).
  useEffect(() => {
    (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) return setErrors((e) => ({ ...e, location: 'Activa la ubicación para encontrar profesionales cerca.' }));
      const { coords } = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setLocation({ lat: coords.latitude, lng: coords.longitude });
      const [place] = await Location.reverseGeocodeAsync(coords);
      if (place) {
        const line = [place.street, place.streetNumber].filter(Boolean).join(' ');
        setAddress((a) => a || [line, place.postalCode, place.city].filter(Boolean).join(', '));
      }
    })().catch(() => setErrors((e) => ({ ...e, location: 'No pudimos obtener tu ubicación.' })));
  }, []);

  if (!category) return <Screen><Text muted>Cargando…</Text></Screen>;

  const pickPhotos = async (source: 'camera' | 'library') => {
    const options: ImagePicker.ImagePickerOptions = {
      mediaTypes: 'images',
      quality: 0.8,
      allowsMultipleSelection: source === 'library',
      selectionLimit: MAX_PHOTOS - photos.length,
    };
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
    if (result.canceled) return;
    const picked = result.assets.map(({ uri, width, height }) => ({ uri, width, height }));
    setPhotos((prev) => [...prev, ...picked].slice(0, MAX_PHOTOS));
  };

  const submit = async () => {
    const draft = {
      categoryId: category.id,
      pricingModel: model,
      offeredPriceEur: model === 'FAST_MATCH' ? category.baseFixedPriceEur : null,
      location: location ?? { lat: NaN, lng: NaN },
      addressText: address,
      description,
      photoUrls: [] as string[], // se rellenan tras subir las fotos
      scheduledAt: null,
    };
    const check = serviceRequestSchema.safeParse(draft);
    if (!check.success || !location) {
      return setErrors({
        ...(check.success ? {} : fieldErrors(check.error)),
        ...(location ? {} : { location: 'Necesitamos tu ubicación.' }),
      });
    }
    setErrors({});
    try {
      // Si el pago se canceló, se reintenta con el mismo checkout en lugar de duplicar la solicitud.
      let created = checkout;
      if (!created) {
        setStep('uploading');
        const photoUrls = await uploadPhotos(photos);
        setStep('creating');
        created = await createRequest.mutateAsync({ ...check.data, photoUrls });
        setCheckout(created);
      }
      // FAST_MATCH: el pago se deposita en Escrow antes de difundir la solicitud.
      if (created.paymentSheet) {
        setStep('paying');
        const paid = await payWithSheet(created.paymentSheet);
        if (paid.status === 'canceled') return setErrors({ form: 'Pago cancelado. Tu reserva sigue pendiente.' });
        if (paid.status === 'failed') return setErrors({ form: paid.message });
      }
      router.replace({ pathname: '/request/[id]', params: { id: created.request.id } });
    } catch {
      setErrors({ form: 'No se pudo crear la solicitud. Revisa tu conexión e inténtalo de nuevo.' });
    } finally {
      setStep('idle');
    }
  };

  const busyLabel = { uploading: 'Subiendo fotos…', creating: 'Creando solicitud…', paying: 'Abriendo pago…', idle: '' }[step];

  return (
    <Screen>
      <Text variant="title">{category.name}</Text>

      {category.allowedModels.length > 1 ? (
        <Segmented
          value={model}
          onChange={setModel}
          options={[
            { value: 'FAST_MATCH', label: '⚡ Precio cerrado' },
            { value: 'BIDDING', label: '📋 Pedir presupuestos' },
          ]}
        />
      ) : null}

      <Card>
        {model === 'FAST_MATCH' ? (
          <>
            <Text muted>Precio cerrado, IVA incluido. El primer profesional disponible lo acepta al instante.</Text>
            <Price tone="brand" amount={category.baseFixedPriceEur} />
          </>
        ) : (
          <Text muted>
            Recibirás presupuestos de profesionales cercanos. Sube fotos para que sean más precisos.
          </Text>
        )}
      </Card>

      <Field label="¿Qué ocurre?" multiline numberOfLines={4} value={description} onChangeText={setDescription}
        placeholder="Ej.: fuga de agua en el sifón del fregadero" error={errors.description} style={{ minHeight: 96, textAlignVertical: 'top' }} />
      <Field label="Dirección (con piso y puerta)" value={address} onChangeText={setAddress} error={errors.addressText ?? errors.location} />

      <View style={{ gap: space.sm }}>
        <Text variant="caption" muted>Fotos del problema ({photos.length}/{MAX_PHOTOS})</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {photos.map((p, i) => (
            <Pressable key={p.uri} accessibilityLabel="Quitar foto" onPress={() => setPhotos((all) => all.filter((_, j) => j !== i))}>
              <Image source={{ uri: p.uri }} style={{ width: 88, height: 88, borderRadius: radius.sm }} />
            </Pressable>
          ))}
        </View>
        {photos.length < MAX_PHOTOS ? (
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <View style={{ flex: 1 }}><Button variant="outline" label="Cámara" onPress={() => void pickPhotos('camera')} /></View>
            <View style={{ flex: 1 }}><Button variant="outline" label="Galería" onPress={() => void pickPhotos('library')} /></View>
          </View>
        ) : null}
      </View>

      {errors.form ? <Text style={{ color: palette.danger }}>{errors.form}</Text> : null}
      {step !== 'idle' ? <Text muted>{busyLabel}</Text> : null}
      <Button
        label={model === 'FAST_MATCH' ? `Reservar por ${formatEur(category.baseFixedPriceEur)}` : 'Pedir presupuestos'}
        loading={step !== 'idle'}
        onPress={() => void submit()}
      />
    </Screen>
  );
}
