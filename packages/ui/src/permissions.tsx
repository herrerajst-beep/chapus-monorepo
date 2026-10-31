import { Linking, Modal, View } from 'react-native';
import { create } from 'zustand';
import { Button, Text } from './components';
import { palette, radius, space, type Tone } from './theme';

/** Forma común de las respuestas de permisos de expo-location / notifications / image-picker. */
export interface PermissionResponseLike {
  granted: boolean;
  canAskAgain: boolean;
}

export interface PrimerCopy {
  icon: string;
  title: string;
  /** Justificación de negocio, en lenguaje llano: qué hacemos con el dato y por qué. */
  body: string;
  /** Texto adicional obligatorio (p. ej. la "prominent disclosure" de Google para segundo plano). */
  disclosure?: string;
  allowLabel?: string;
  tone?: Tone;
}

interface PrimerRequest extends PrimerCopy {
  mode: 'ask' | 'settings';
  resolve: (accepted: boolean) => void;
}

const usePrimerStore = create<{ current: PrimerRequest | null }>(() => ({ current: null }));

const showPrimer = (copy: PrimerCopy, mode: PrimerRequest['mode']) =>
  new Promise<boolean>((resolve) => usePrimerStore.setState({ current: { ...copy, mode, resolve } }));

/**
 * Pide un permiso en el momento en que el usuario inicia la acción que lo necesita, con
 * una pantalla previa que justifica el uso (requisito de App Review 5.1.1 y de la
 * política de Google Play para datos sensibles). Nunca se llama en el arranque.
 *
 * - Ya concedido → true sin mostrar nada.
 * - Denegado sin posibilidad de volver a preguntar → ofrece abrir Ajustes.
 * - Pendiente → muestra la justificación y, solo si acepta, el diálogo del sistema.
 */
export async function ensurePermission(opts: {
  get: () => Promise<PermissionResponseLike>;
  request: () => Promise<PermissionResponseLike>;
  primer: PrimerCopy;
}): Promise<boolean> {
  const current = await opts.get();
  if (current.granted) return true;
  if (!current.canAskAgain) {
    if (await showPrimer(opts.primer, 'settings')) await Linking.openSettings();
    return false;
  }
  if (!(await showPrimer(opts.primer, 'ask'))) return false;
  return (await opts.request()).granted;
}

/** Montar una vez en el layout raíz. */
export function PermissionPrimerHost() {
  const current = usePrimerStore((s) => s.current);
  const close = (accepted: boolean) => {
    current?.resolve(accepted);
    usePrimerStore.setState({ current: null });
  };

  return (
    <Modal visible={current !== null} transparent animationType="slide" onRequestClose={() => close(false)}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.45)' }}>
        {current ? (
          <View
            accessibilityViewIsModal
            style={{
              backgroundColor: palette.surface,
              borderTopLeftRadius: radius.lg,
              borderTopRightRadius: radius.lg,
              padding: space.xl,
              paddingBottom: space.xxl,
              gap: space.md,
            }}
          >
            <Text style={{ fontSize: 40 }} accessibilityElementsHidden>{current.icon}</Text>
            <Text variant="title">{current.title}</Text>
            <Text>{current.body}</Text>
            {current.disclosure ? <Text variant="caption" muted>{current.disclosure}</Text> : null}
            {current.mode === 'settings' ? (
              <Text variant="caption" muted>
                Lo desactivaste anteriormente. Puedes activarlo en los Ajustes del teléfono.
              </Text>
            ) : null}
            <Button
              tone={current.tone ?? 'brand'}
              label={current.mode === 'settings' ? 'Abrir Ajustes' : (current.allowLabel ?? 'Continuar')}
              onPress={() => close(true)}
            />
            <Button tone="neutral" variant="outline" label="Ahora no" onPress={() => close(false)} />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}
