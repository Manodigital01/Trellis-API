import { Injectable, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "crypto";
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

interface Challenge {
  id: string;
  message: string;
  createdAt: number;
  expiresAt: number;
  address: string;
}

export type WebAuthnChallengeType = "registration" | "authentication";

interface WebAuthnChallengeRecord {
  challenge: string;
  userId?: string;
  type: WebAuthnChallengeType;
  createdAt: number;
  expiresAt: number;
}

export type WebAuthnTransport =
  | "ble"
  | "cable"
  | "hybrid"
  | "internal"
  | "nfc"
  | "smart-card"
  | "usb";

export interface StoredPasskeyCredential {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: WebAuthnTransport[];
  createdAt: number;
  lastUsedAt?: number;
}

@Injectable()
export class ChallengeService {
  private challenges = new Map<string, Challenge>();
  private readonly webAuthnChallenges = new Map<string, WebAuthnChallengeRecord>();
  private readonly passkeys = new Map<string, StoredPasskeyCredential[]>();
  private readonly challengeExpiration = 5 * 60 * 1000; // 5 minutes
  private readonly webAuthnChallengeExpiration = 5 * 60 * 1000;

  issueChallengeForAddress(address: string): string {
    const challengeId = randomBytes(32).toString("hex");
    const now = Date.now();
    const message = `Sign this message to authenticate: ${challengeId}`;

    const challenge: Challenge = {
      id: challengeId,
      message,
      createdAt: now,
      expiresAt: now + this.challengeExpiration,
      address: address.toLowerCase(),
    };

    this.challenges.set(challengeId, challenge);
    return message;
  }

  getChallenge(challengeId: string): Challenge | null {
    const challenge = this.challenges.get(challengeId);

    if (!challenge) {
      return null;
    }

    if (Date.now() > challenge.expiresAt) {
      this.challenges.delete(challengeId);
      return null;
    }

    return challenge;
  }

  consumeChallenge(challengeId: string): Challenge | null {
    const challenge = this.getChallenge(challengeId);

    if (challenge) {
      this.challenges.delete(challengeId);
    }

    return challenge;
  }

  extractChallengeId(message: string): string | null {
    const match = message.match(/Sign this message to authenticate: (.+)$/);
    return match ? match[1] : null;
  }

  generateWebAuthnChallenge(
    userId?: string,
    type: WebAuthnChallengeType = "authentication",
  ): string {
    const challenge = randomBytes(32).toString("base64url");
    const now = Date.now();
    const record: WebAuthnChallengeRecord = {
      challenge,
      userId,
      type,
      createdAt: now,
      expiresAt: now + this.webAuthnChallengeExpiration,
    };

    this.webAuthnChallenges.set(challenge, record);
    return challenge;
  }

  getWebAuthnChallenge(challenge: string): WebAuthnChallengeRecord | null {
    const record = this.webAuthnChallenges.get(challenge);
    if (!record) {
      return null;
    }

    if (Date.now() > record.expiresAt) {
      this.webAuthnChallenges.delete(challenge);
      return null;
    }

    return record;
  }

  consumeWebAuthnChallenge(challenge: string): WebAuthnChallengeRecord | null {
    const record = this.getWebAuthnChallenge(challenge);
    if (record) {
      this.webAuthnChallenges.delete(challenge);
    }
    return record;
  }

  generatePasskeyRegistrationChallenge(userId: string): string {
    return this.generateWebAuthnChallenge(userId, "registration");
  }

  generatePasskeyAuthenticationChallenge(userId: string): string {
    return this.generateWebAuthnChallenge(userId, "authentication");
  }

  storePasskeyCredential(
    userId: string,
    credential: Omit<StoredPasskeyCredential, "createdAt" | "lastUsedAt">,
  ): StoredPasskeyCredential {
    const storedCredential: StoredPasskeyCredential = {
      ...credential,
      createdAt: Date.now(),
    };

    const existing = this.passkeys.get(userId) ?? [];
    const next = existing.filter(
      (entry) => entry.credentialId !== storedCredential.credentialId,
    );

    next.push(storedCredential);
    this.passkeys.set(userId, next);
    return storedCredential;
  }

  getStoredPasskeys(userId: string): StoredPasskeyCredential[] {
    return [...(this.passkeys.get(userId) ?? [])];
  }

  async verifyWebAuthnRegistration(
    userId: string,
    registrationResponse: any,
    expectedChallenge: string,
    rpID: string,
    expectedOrigin?: string,
  ): Promise<boolean> {
    const challenge = this.consumeWebAuthnChallenge(expectedChallenge);
    if (!challenge) {
      throw new UnauthorizedException("Invalid or expired WebAuthn challenge");
    }

    if (challenge.userId && challenge.userId !== userId) {
      throw new UnauthorizedException("WebAuthn challenge mismatch for user");
    }

    const verification = await verifyRegistrationResponse({
      response: registrationResponse,
      expectedChallenge,
      expectedOrigin: expectedOrigin ?? "https://example.com",
      expectedRPID: rpID,
      requireUserVerification: false,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new UnauthorizedException("Invalid WebAuthn registration response");
    }

    const credential = verification.registrationInfo.credential;
    const credentialId = this.resolveCredentialId(credential.id);
    const publicKey = Buffer.from(credential.publicKey).toString("base64url");

    this.storePasskeyCredential(userId, {
      credentialId,
      publicKey,
      counter: Number(credential.counter ?? 0),
      transports: credential.transports ?? [],
    });

    return true;
  }

  async verifyWebAuthnAuthentication(
    userId: string,
    assertionResponse: any,
    expectedChallenge: string,
    rpID: string,
    expectedOrigin?: string,
  ): Promise<boolean> {
    const challenge = this.consumeWebAuthnChallenge(expectedChallenge);
    if (!challenge) {
      throw new UnauthorizedException("Invalid or expired WebAuthn challenge");
    }

    if (challenge.userId && challenge.userId !== userId) {
      throw new UnauthorizedException("WebAuthn challenge mismatch for user");
    }

    const storedPasskeys = this.passkeys.get(userId) ?? [];
    const credentialId = this.resolveCredentialId(
      assertionResponse?.id ?? assertionResponse?.rawId,
    );
    const passkey = storedPasskeys.find(
      (entry) =>
        entry.credentialId === credentialId ||
        this.resolveCredentialId(entry.credentialId) === credentialId,
    );

    if (!passkey) {
      throw new UnauthorizedException("Passkey not registered for this user");
    }

    const verification = await verifyAuthenticationResponse({
      response: assertionResponse,
      expectedChallenge,
      expectedOrigin: expectedOrigin ?? "https://example.com",
      expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: passkey.credentialId,
        publicKey: Buffer.from(passkey.publicKey, "base64url"),
        counter: passkey.counter,
        transports: passkey.transports,
      },
    });

    if (!verification.verified) {
      throw new UnauthorizedException("Invalid WebAuthn assertion signature");
    }

    const nextCounter = Number(verification.authenticationInfo.newCounter ?? passkey.counter);
    if (nextCounter <= passkey.counter) {
      throw new UnauthorizedException("Invalid or replayed WebAuthn assertion");
    }

    const updated = storedPasskeys.map((entry) =>
      entry.credentialId === passkey.credentialId
        ? { ...entry, counter: nextCounter, lastUsedAt: Date.now() }
        : entry,
    );
    this.passkeys.set(userId, updated);

    return true;
  }

  verifyPasskeyRegistration(
    userId: string,
    registrationResponse: any,
    expectedChallenge: string,
    rpID: string,
    expectedOrigin?: string,
  ): Promise<boolean> {
    return this.verifyWebAuthnRegistration(
      userId,
      registrationResponse,
      expectedChallenge,
      rpID,
      expectedOrigin,
    );
  }

  verifyPasskeyAuthentication(
    userId: string,
    assertionResponse: any,
    expectedChallenge: string,
    rpID: string,
    expectedOrigin?: string,
  ): Promise<boolean> {
    return this.verifyWebAuthnAuthentication(
      userId,
      assertionResponse,
      expectedChallenge,
      rpID,
      expectedOrigin,
    );
  }

  private toBase64UrlString(value: string | Uint8Array | Buffer): string {
    if (typeof value === "string") {
      return value;
    }

    return Buffer.from(value).toString("base64url");
  }

  private resolveCredentialId(value: string | Uint8Array | Buffer | undefined): string {
    if (!value) {
      return "";
    }

    if (typeof value === "string") {
      return value;
    }

    return Buffer.from(value).toString("base64url");
  }
}
