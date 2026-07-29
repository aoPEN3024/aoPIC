const encoder = new TextEncoder();
const WHITESPACE_RE = /[\s\u00a0\u3000]/u;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

export function textLength(value) {
  return Array.from(String(value ?? "")).length;
}

export function inspectPass(value, {
  label,
  minLength,
  maxLength,
  maxBytes = 72
}) {
  const text = String(value ?? "");
  const length = textLength(text);
  const bytes = encoder.encode(text).length;
  let error = "";
  let errorCode = "";

  if (!text) {
    errorCode = "required";
    error = `${label}を入力してください`;
  } else if (WHITESPACE_RE.test(text)) {
    errorCode = "whitespace";
    error = `${label}に空白や改行が含まれています。${label}をコピーし直してください`;
  } else if (CONTROL_RE.test(text) || INVISIBLE_RE.test(text)) {
    errorCode = "invalid_character";
    error = `${label}に使用できない文字が含まれています。${label}をコピーし直してください`;
  } else if (length < minLength) {
    errorCode = "too_short";
    error = `${label}は${minLength}文字以上で入力してください`;
  } else if (length > maxLength) {
    errorCode = "too_long";
    error = `${label}が長すぎます（${maxLength}文字以内）`;
  } else if (bytes > maxBytes) {
    errorCode = "too_many_bytes";
    error = `${label}が長すぎます。全角文字を含む場合は短くしてください`;
  }

  return { valid: !error, error, errorCode, length, bytes, value: text };
}

export function requirePass(value, options) {
  const result = inspectPass(value, options);
  if (!result.valid) {
    const error = new Error(result.error);
    error.validationCode = result.errorCode;
    throw error;
  }
  return result.value;
}

export function validateCompanyPass(value) {
  return requirePass(value, {
    label: "会社PASS",
    minLength: 16,
    maxLength: 64,
    maxBytes: 72
  });
}

export function validateProjectPass(value) {
  return requirePass(value, {
    label: "工事PASS",
    minLength: 8,
    maxLength: 64,
    maxBytes: 72
  });
}

export function validateAdministratorPass(value, confirmation) {
  const code = requirePass(value, {
    label: "管理者PASS",
    minLength: 8,
    maxLength: 64,
    maxBytes: 72
  });
  if (code !== String(confirmation ?? "")) throw new Error("管理者PASSと確認入力が一致しません");
  const categories = [
    /[a-z]/.test(code),
    /[A-Z]/.test(code),
    /[0-9]/.test(code),
    /[^A-Za-z0-9]/.test(code)
  ].filter(Boolean).length;
  if (categories < 2
      || /^(password|admin|administrator|qwerty|letmein|aopen|aoalb|aopic|12345678|87654321)$/i.test(code)
      || /^(.)\1{7,}$/u.test(code)) {
    throw new Error("管理者PASSは英字・数字・記号のうち2種類以上を使用し、推測されにくい内容にしてください");
  }
  return code;
}
