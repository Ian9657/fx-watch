// A damped spring's way from 0 to 1: t in seconds, omega its stiffness in
// radians a second, zeta its damping (below 1 it overshoots and rings).
export function spring(t, omega, zeta) {
  const d = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * t) * (Math.cos(d * t) + (zeta * omega / d) * Math.sin(d * t));
}

// The spring sampled once a frame for `seconds`, as values for keyframes.
export const springSamples = (seconds, omega, zeta, rate = 60) =>
  Array.from({ length: Math.round(seconds * rate) + 1 }, (_, i) => spring(i / rate, omega, zeta));
