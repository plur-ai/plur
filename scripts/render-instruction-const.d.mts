export function evaluateConst(
  source: string,
  name: string,
  depth?: number,
): { text: string; error?: undefined; missing?: undefined }
  | { missing: true; text?: undefined; error?: undefined }
  | { error: string; text?: undefined; missing?: undefined }
