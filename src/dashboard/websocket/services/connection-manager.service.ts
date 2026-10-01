import { Injectable, Logger, Optional } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { ConnectionInfo } from "../interfaces/websocket.interfaces";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class ConnectionManagerService {
  private readonly logger = new Logger(ConnectionManagerService.name);

  // Map of clientId -> ConnectionInfo
  private connections: Map<string, ConnectionInfo> = new Map();

  // Map of userId -> Set of clientIds
  private userConnections: Map<string, Set<string>> = new Map();

  // Map of clientId -> disconnectedAt timestamp
  private disconnectedClients: Map<string, Date> = new Map();

  constructor(@Optional() private readonly configService?: ConfigService) {}

  /**
   * Register a new WebSocket connection
   */
  async registerConnection(
    clientId: string,
    info: ConnectionInfo,
  ): Promise<boolean> {
    const max = this.configService?.get<number>("MAX_WS_CONNECTIONS_PER_USER") ??
      Number(process.env.MAX_WS_CONNECTIONS_PER_USER ?? 5);
    const active = this.getUserConnections(info.userId).filter((c) => c.isAlive);
    if (active.length >= max) {
      this.logger.warn(`Connection limit reached for user ${info.userId}`);
      return false;
    }
    this.connections.set(clientId, {
      ...info,
      isAlive: true,
      subscriptions: [],
    });

    // Track user's connections
    if (!this.userConnections.has(info.userId)) {
      this.userConnections.set(info.userId, new Set());
    }
    this.userConnections.get(info.userId).add(clientId);

    this.logger.debug(
      `Registered connection: ${clientId} for user ${info.userId}`,
    );
    return true;
  }

  /**
   * Get connection information by client ID
   */
  getConnectionInfo(clientId: string): ConnectionInfo | null {
    return this.connections.get(clientId) || null;
  }

  /**
   * Get all connections for a specific user
   */
  getUserConnections(userId: string): ConnectionInfo[] {
    const clientIds = this.userConnections.get(userId);
    if (!clientIds) return [];

    return Array.from(clientIds)
      .map((id) => this.connections.get(id))
      .filter((conn): conn is ConnectionInfo => conn !== undefined);
  }

  /**
   * Check if a user has any active connections
   */
  hasActiveConnection(userId: string): boolean {
    const connections = this.getUserConnections(userId);
    return connections.some((conn) => conn.isAlive);
  }

  /**
   * Update heartbeat timestamp for a connection
   */
  updateHeartbeat(clientId: string): void {
    const connection = this.connections.get(clientId);
    if (connection) {
      connection.lastHeartbeat = new Date();
      connection.isAlive = true;
    }
  }

  /**
   * Mark a connection as disconnected
   */
  markDisconnected(clientId: string): void {
    const connection = this.connections.get(clientId);
    if (connection) {
      connection.isAlive = false;
      this.disconnectedClients.set(clientId, new Date());

      // Remove from user connections but keep connection info for event buffering
      const userConnections = this.userConnections.get(connection.userId);
      if (userConnections) {
        userConnections.delete(clientId);
      }
    }
  }

  /**
   * Remove a connection completely
   */
  removeConnection(clientId: string): void {
    const connection = this.connections.get(clientId);

    if (connection) {
      // Remove from user connections
      const userConnections = this.userConnections.get(connection.userId);
      if (userConnections) {
        userConnections.delete(clientId);

        // Clean up empty sets
        if (userConnections.size === 0) {
          this.userConnections.delete(connection.userId);
        }
      }

      this.connections.delete(clientId);
      this.disconnectedClients.delete(clientId);

      this.logger.debug(`Removed connection: ${clientId}`);
    }
  }

  /**
   * Subscribe to a portfolio
   */
  subscribeToPortfolio(clientId: string, portfolioId: string): void {
    const connection = this.connections.get(clientId);
    if (connection && !connection.subscriptions.includes(portfolioId)) {
      connection.subscriptions.push(portfolioId);
    }
  }

  /**
   * Unsubscribe from a portfolio
   */
  unsubscribeFromPortfolio(clientId: string, portfolioId: string): void {
    const connection = this.connections.get(clientId);
    if (connection) {
      connection.subscriptions = connection.subscriptions.filter(
        (id) => id !== portfolioId,
      );
    }
  }

  /**
   * Get connections that haven't had a heartbeat within the given threshold (stale connections)
   */
  getStaleConnections(thresholdMs: number): Map<string, ConnectionInfo> {
    const staleConnections = new Map<string, ConnectionInfo>();
    const now = Date.now();

    for (const [clientId, info] of this.connections.entries()) {
      const timeSinceHeartbeat = now - info.lastHeartbeat.getTime();
      if (timeSinceHeartbeat > thresholdMs) {
        staleConnections.set(clientId, info);
      }
    }

    return staleConnections;
  }

  /**
   * Get total number of active connections
   */
  getConnectionCount(): number {
    let count = 0;
    for (const connection of this.connections.values()) {
      if (connection.isAlive) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get connection statistics
   */
  getStats(): {
    total: number;
    active: number;
    stale: number;
    byUser: Map<string, number>;
  } {
    let active = 0;
    let stale = 0;

    for (const connection of this.connections.values()) {
      if (connection.isAlive) {
        active++;
      } else {
        stale++;
      }
    }

    const byUser = new Map<string, number>();
    for (const [userId, connections] of this.userConnections.entries()) {
      byUser.set(userId, connections.size);
    }

    return {
      total: this.connections.size,
      active,
      stale,
      byUser,
    };
  }

  /**
   * Clean up all inactive connections
   */
  cleanupInactiveConnections(maxAgeMs: number): string[] {
    const removed: string[] = [];
    const now = Date.now();

    for (const [
      clientId,
      disconnectedAt,
    ] of this.disconnectedClients.entries()) {
      if (now - disconnectedAt.getTime() > maxAgeMs) {
        this.removeConnection(clientId);
        removed.push(clientId);
      }
    }

    return removed;
  }

  /**
   * Get all subscriptions for a portfolio
   */
  getPortfolioSubscribers(portfolioId: string): string[] {
    const subscribers: string[] = [];

    for (const [clientId, info] of this.connections.entries()) {
      if (info.isAlive && info.subscriptions.includes(portfolioId)) {
        subscribers.push(clientId);
      }
    }

    return subscribers;
  }

  /**
   * Get connection ID for a user (first active connection)
   */
  getUserConnectionId(userId: string): string | null {
    const connections = this.userConnections.get(userId);
    if (!connections || connections.size === 0) return null;

    return Array.from(connections)[0];
  }

  /**
   * Update connection metadata
   */
  updateMetadata(clientId: string, metadata: Record<string, any>): void {
    const connection = this.connections.get(clientId);
    if (connection) {
      connection.metadata = { ...connection.metadata, ...metadata };
    }
  }
}
