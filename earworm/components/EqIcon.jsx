// Tiny three-bar equalizer. Animates when `active`, sits still otherwise.
// Pure CSS (see .eq styles in globals.css) so it costs nothing.

export default function EqIcon({ active = false, size = 16 }) {
  return (
    <span
      className={`eq ${active ? "eq-active" : ""}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span />
      <span />
      <span />
    </span>
  );
}
