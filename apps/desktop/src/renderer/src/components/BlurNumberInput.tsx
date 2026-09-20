import { useEffect, useState } from "react";

interface Props {
  value: number;
  min?: number;
  max?: number;
  onCommit: (n: number) => void;
}

function clamp(n: number, min?: number, max?: number): number {
  let c = n;
  if (min !== undefined && c < min) c = min;
  if (max !== undefined && c > max) c = max;
  return c;
}

export function BlurNumberInput({ value, min, max, onCommit }: Props) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw === "") {
      setText("");
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setText(raw);
      return;
    }
    setText(String(clamp(n, min, max)));
  };

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === "" || !Number.isFinite(Number(trimmed))) {
      setText(String(value));
      return;
    }
    const c = clamp(Number(trimmed), min, max);
    setText(String(c));
    if (c !== value) onCommit(c);
  };

  return (
    <input
      type="number"
      min={min}
      max={max}
      value={text}
      onChange={handleChange}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      style={{
        width: 56,
        padding: "4px 6px",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        color: "var(--text)",
        fontSize: "13px",
        outline: "none",
        textAlign: "center",
      }}
    />
  );
}
