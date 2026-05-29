import { IcebergMark } from "./IcebergMark";

// Footer / certificate seal — a guilloché crop in a double ring with the berg centered.
// The guilloché sits under the berg at `multiply` so the warm paper shows through.

type Props = { size?: number; accent?: boolean; className?: string };

export function IcebergSeal({ size = 104, accent = false, className }: Props) {
  return (
    <span
      className={`iceberg-seal${accent ? " accent" : ""}${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <span className="iceberg-seal-fill" />
      <IcebergMark size={Math.round(size * 0.52)} className="iceberg-seal-berg" />
    </span>
  );
}
