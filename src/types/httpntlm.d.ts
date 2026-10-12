declare module "httpntlm" {
  export interface NtlmResponse {
    statusCode?: number;
    body?: string | Buffer;
  }

  export interface NtlmOptions {
    url: string;
    username: string;
    password: string;
    domain?: string;
    workstation?: string;
    headers?: Record<string, string>;
    body?: string;
    agent?: object;
    timeout?: number;
  }

  const httpntlm: {
    post(options: NtlmOptions, callback: (err: Error | null, res?: NtlmResponse) => void): void;
  };

  export default httpntlm;
}
