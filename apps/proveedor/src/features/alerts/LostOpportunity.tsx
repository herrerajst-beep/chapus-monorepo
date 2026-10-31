import { useEffect } from 'react';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Button, Card, Screen, Text, palette } from '@chapus/ui';

/**
 * Pantalla de oportunidad perdida: explica qué pasó sin tono de error y devuelve al radar.
 * Sustituye a los textos rojos sueltos para que perder una carrera no parezca un fallo.
 */
export function LostOpportunity() {
  useEffect(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }, []);

  return (
    <Screen>
      <Card style={{ alignItems: 'center', paddingVertical: 32, borderColor: palette.line }}>
        <Text style={{ fontSize: 44 }} accessibilityElementsHidden>🤝</Text>
        <Text variant="heading" style={{ textAlign: 'center' }}>Otro profesional se adelantó</Text>
        <Text muted style={{ textAlign: 'center' }}>
          Este trabajo ya está asignado. Sigues disponible y te avisaremos en cuanto entre el próximo
          trabajo cerca de ti.
        </Text>
      </Card>
      <Button
        tone="provider"
        label="Volver al radar"
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
    </Screen>
  );
}
