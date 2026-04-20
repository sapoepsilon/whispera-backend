import { randomBytes, createHash } from 'node:crypto';

interface OAuthState {
  userId: string;
  codeVerifier: string;
  createdAt: number;
}

const pendingStates = new Map<string, OAuthState>();

const STATE_TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, state] of pendingStates) {
    if (now - state.createdAt > STATE_TTL_MS) pendingStates.delete(key);
  }
}, STATE_TTL_MS).unref();

export class OpenAICodexOAuthService {
  private readonly clientId: string;
  private readonly redirectUri: string;

  constructor() {
    this.clientId = process.env.OPENAI_CLIENT_ID || 'whispera-app';
    this.redirectUri = process.env.OPENAI_REDIRECT_URI || 'http://localhost:3000/auth/oauth/openai/callback';
  }

  generateAuthorizationUrl(userId: string): { url: string; state: string } {
    const state = randomBytes(32).toString('hex');
    const codeVerifier = randomBytes(32).toString('hex');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    pendingStates.set(state, {
      userId,
      codeVerifier,
      createdAt: Date.now(),
    });

    const params = new URLSearchParams({
      client_id: this.clientId,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid',
    });

    return {
      url: `https://auth.openai.com/authorize?${params.toString()}`,
      state,
    };
  }

  validateState(state: string): OAuthState | null {
    const pending = pendingStates.get(state);
    if (!pending) return null;

    if (Date.now() - pending.createdAt > STATE_TTL_MS) {
      pendingStates.delete(state);
      return null;
    }

    return pending;
  }

  consumeState(state: string): OAuthState | null {
    const pending = this.validateState(state);
    if (pending) {
      pendingStates.delete(state);
    }
    return pending;
  }

  async exchangeCodeForTokens(
    code: string,
    codeVerifier: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    if (process.env.NODE_ENV === 'test') {
      return {
        accessToken: `test-access-token-${code}`,
        refreshToken: `test-refresh-token-${code}`,
        expiresIn: 3600,
      };
    }

    const response = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        client_id: this.clientId,
        redirect_uri: this.redirectUri,
      }),
    });

    const data = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  async refreshAccessToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const response = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.clientId,
      }),
    });

    const data = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }
}
