import { UnauthorizedException } from "@nestjs/common";
import * as simpleWebAuthnServer from "@simplewebauthn/server";
import { ChallengeService } from "./challenge.service";

jest.mock("@simplewebauthn/server", () => ({
  verifyRegistrationResponse: jest.fn(),
  verifyAuthenticationResponse: jest.fn(),
}));

describe("ChallengeService", () => {
  let service: ChallengeService;
  const mockedWebAuthn = simpleWebAuthnServer as jest.Mocked<typeof simpleWebAuthnServer>;

  beforeEach(() => {
    service = new ChallengeService();
    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("issueChallengeForAddress", () => {
    it("should return a non-empty challenge message", () => {
      const address = "0x1234567890abcdef1234567890abcdef12345678";
      const message = service.issueChallengeForAddress(address);
      expect(message).toBeDefined();
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    });

    it("should generate unique messages on each call", () => {
      const address = "0x1234567890abcdef1234567890abcdef12345678";
      const msg1 = service.issueChallengeForAddress(address);
      const msg2 = service.issueChallengeForAddress(address);
      expect(msg1).not.toBe(msg2);
    });

    it("should include the authentication phrase in the challenge", () => {
      const address = "0x1234567890abcdef1234567890abcdef12345678";
      const message = service.issueChallengeForAddress(address);
      expect(message).toContain("Sign this message to authenticate:");
    });
  });

  describe("getChallenge", () => {
    it("should return null for an unknown challenge ID", async () => {
      const result = await service.getChallenge("nonexistent-id");
      expect(result).toBeNull();
    });
  });

  describe("consumeChallenge", () => {
    it("should return null when consuming a nonexistent challenge", async () => {
      const result = await service.consumeChallenge("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("webauthn challenges", () => {
    it("should generate a 32-byte cryptographically secure challenge", () => {
      const challenge = service.generateWebAuthnChallenge("user-1", "authentication");

      expect(Buffer.from(challenge, "base64url")).toHaveLength(32);
      expect(service.getWebAuthnChallenge(challenge)).toMatchObject({
        userId: "user-1",
        type: "authentication",
      });
    });

    it("should verify a valid WebAuthn registration response and persist the passkey", async () => {
      const challenge = service.generateWebAuthnChallenge("user-1", "registration");
      const response = {
        id: "credential-123",
        rawId: "credential-123",
        type: "public-key",
        response: {
          clientDataJSON: "client-data",
          attestationObject: "attestation-object",
          transports: ["internal"],
          getTransports: () => ["internal"],
        },
        clientExtensionResults: {},
      };

      mockedWebAuthn.verifyRegistrationResponse.mockResolvedValue({
        verified: true,
        registrationInfo: {
          credential: {
            id: "credential-123",
            publicKey: Buffer.from("public-key"),
            counter: 0,
            transports: ["internal"],
          },
        },
      } as any);

      await expect(
        service.verifyWebAuthnRegistration(
          "user-1",
          response as any,
          challenge,
          "example.com",
        ),
      ).resolves.toBe(true);

      expect(service.getStoredPasskeys("user-1")).toContainEqual(
        expect.objectContaining({
          credentialId: "credential-123",
          publicKey: expect.any(String),
          transports: ["internal"],
        }),
      );
    });

    it("should reject invalid or replayed passkey assertions with 401", async () => {
      const validChallenge = service.generateWebAuthnChallenge("user-2", "authentication");
      service.storePasskeyCredential("user-2", {
        credentialId: "credential-456",
        publicKey: "cHVibGljLWtleQ==",
        counter: 0,
        transports: ["internal"],
      });

      const validResponse = {
        id: "credential-456",
        rawId: "credential-456",
        type: "public-key",
        response: {
          clientDataJSON: "client-data",
          authenticatorData: "authenticator-data",
          signature: "signature",
          userHandle: null,
        },
        clientExtensionResults: {},
      };

      mockedWebAuthn.verifyAuthenticationResponse.mockResolvedValue({
        verified: true,
        authenticationInfo: {
          newCounter: 1,
          credentialID: Buffer.from("credential-456"),
          userVerified: true,
        },
      } as any);

      await expect(
        service.verifyWebAuthnAuthentication(
          "user-2",
          validResponse as any,
          validChallenge,
          "example.com",
        ),
      ).resolves.toBe(true);

      await expect(
        service.verifyWebAuthnAuthentication(
          "user-2",
          validResponse as any,
          validChallenge,
          "example.com",
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      const invalidChallenge = service.generateWebAuthnChallenge("user-2", "authentication");
      mockedWebAuthn.verifyAuthenticationResponse.mockResolvedValue({
        verified: false,
      } as any);

      await expect(
        service.verifyWebAuthnAuthentication(
          "user-2",
          validResponse as any,
          invalidChallenge,
          "example.com",
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
