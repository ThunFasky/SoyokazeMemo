/** キャンバス背景（海外の下書き用紙っぽいグレー）。エクスポート PNG にもこの色が入る。 */
export const CANVAS_BG = "#d9dcd6";

export interface PaletteColor {
  name: string;
  value: string;
}

/** 原色から彩度を少し抜いた、目に優しい固定パレット。キーボードの 1〜8 に対応。 */
export const PALETTE: readonly PaletteColor[] = [
  { name: "墨（ダークグレー）", value: "#34373b" },
  { name: "くすんだ赤", value: "#b5524c" },
  { name: "テラコッタ", value: "#c47a45" },
  { name: "マスタード", value: "#be9530" },
  { name: "セージグリーン", value: "#6e9a6e" },
  { name: "スレートブルー", value: "#4c6f96" },
  { name: "モーブ", value: "#846c9e" },
  { name: "オフホワイト", value: "#f6f3ec" },
];

export const SIZE_MIN = 1;
export const SIZE_MAX = 80;
