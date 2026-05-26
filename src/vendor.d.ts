declare module "qrcode-terminal" {
  export function generate(input: string, opts: { small: boolean }, cb: (output: string) => void): void;
  export default { generate };
}
