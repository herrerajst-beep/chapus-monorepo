import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as RNText,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type ViewStyle,
} from 'react-native';
import { formatEur } from '@chapus/core';
import { palette, radius, space, toneColor, typography, type Tone } from './theme';

type Variant = keyof typeof typography;

export function Text({ variant = 'body', muted, style, ...rest }: TextProps & { variant?: Variant; muted?: boolean }) {
  return <RNText style={[typography[variant], { color: muted ? palette.inkMuted : palette.ink }, style]} {...rest} />;
}

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  if (!scroll) return <View style={styles.screen}>{children}</View>;
  return (
    <ScrollView style={{ backgroundColor: palette.background }} contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  if (!onPress) return <View style={[styles.card, style]}>{children}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }, style]}>
      {children}
    </Pressable>
  );
}

interface ButtonProps {
  label: string;
  onPress: () => void;
  tone?: Tone;
  variant?: 'solid' | 'outline';
  loading?: boolean;
  disabled?: boolean;
}

export function Button({ label, onPress, tone = 'brand', variant = 'solid', loading, disabled }: ButtonProps) {
  const c = toneColor[tone];
  const solid = variant === 'solid';
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: solid ? c.solid : 'transparent', borderColor: c.solid },
        (pressed || inactive) && { opacity: 0.6 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={solid ? palette.surface : c.solid} />
      ) : (
        <RNText style={[typography.heading, { color: solid ? palette.surface : c.solid }]}>{label}</RNText>
      )}
    </Pressable>
  );
}

export function Field({ label, error, style, ...input }: TextInputProps & { label: string; error?: string }) {
  return (
    <View style={{ gap: space.xs }}>
      <Text variant="caption" muted>
        {label}
      </Text>
      <TextInput
        placeholderTextColor={palette.inkMuted}
        style={[styles.input, error ? { borderColor: palette.danger } : null, style]}
        {...input}
      />
      {error ? <Text variant="caption" style={{ color: palette.danger }}>{error}</Text> : null}
    </View>
  );
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  const c = toneColor[tone];
  return (
    <View style={[styles.badge, { backgroundColor: c.soft }]}>
      <RNText style={[typography.caption, { color: c.solid, fontWeight: '600' }]}>{label}</RNText>
    </View>
  );
}

export function Price({ amount, tone = 'neutral' }: { amount: number; tone?: Tone }) {
  return <RNText style={[typography.price, { color: toneColor[tone].solid }]}>{formatEur(amount)}</RNText>;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(o.value)}
            style={[styles.segment, active && { backgroundColor: palette.surface }]}
          >
            <Text variant="caption" style={{ fontWeight: active ? '700' : '400' }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flexGrow: 1, padding: space.lg, gap: space.lg, backgroundColor: palette.background },
  card: {
    backgroundColor: palette.surface,
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
  },
  button: {
    minHeight: 52,
    borderRadius: radius.md,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    backgroundColor: palette.surface,
    color: palette.ink,
    fontSize: 16,
  },
  badge: { alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.pill },
  segmented: { flexDirection: 'row', backgroundColor: palette.line, borderRadius: radius.sm, padding: 3 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: space.sm, borderRadius: radius.sm - 2 },
});
