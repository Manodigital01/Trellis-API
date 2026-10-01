// WebSocket event types
export enum DashboardEvent {
  // Connection events
  CONNECTION_ESTABLISHED = "connection:established",
  CONNECTION_STALE = "connection:stale",
  RECONNECTION_SUCCESS = "reconnection:success",

  // Heartbeat events
  HEARTBEAT = "heartbeat",
  PING = "ping",
  PONG = "pong",

  // Subscription events
  SUBSCRIBE_PORTFOLIO = "portfolio:subscribe",
  SUBSCRIPTION_CONFIRMED = "portfolio:subscription:confirmed",
  UNSUBSCRIBE_PORTFOLIO = "portfolio:unsubscribe",
  UNSUBSCRIPTION_CONFIRMED = "portfolio:unsubscription:confirmed",

  // Data events
  PORTFOLIO_UPDATE = "portfolio:update",
  PERFORMANCE_UPDATE = "portfolio:performance:update",
  ALLOCATION_UPDATE = "portfolio:allocation:update",
  RISK_UPDATE = "portfolio:risk:update",
  HOLDINGS_UPDATE = "portfolio:holdings:update",

  // Replay events
  REPLAY_EVENTS = "events:replay",
  EVENTS_REPLAYED = "events:replayed",

  // Alert events
  ALERT_TRIGGERED = "alert:triggered",

  // Error events
  ERROR = "error",
  MAX_CONNECTIONS_EXCEEDED = "MAX_CONNECTIONS_EXCEEDED",
}

// Connection information stored per client
export interface ConnectionInfo {
  userId: string;
  clientId: string;
  connectedAt: Date;
  lastHeartbeat: Date;
  isAlive: boolean;
  subscriptions: string[];
  metadata?: Record<string, any>;
}

// Buffered event for replay
export interface BufferedEvent {
  event: DashboardEvent;
  data: any;
  timestamp: Date;
}

// Client message format
export interface ClientMessage<T = any> {
  type?: string;
  data: T;
  requestId?: string;
}

// Dashboard specific payload types
export interface DashboardPayload {
  portfolioId?: string;
  timestamp?: string;
  data?: any;
}

export interface HeartbeatMessage {
  timestamp?: string;
  clientTime?: number;
}

export interface ReconnectionPayload {
  missedEvents: number;
  events: BufferedEvent[];
  clientId?: string;
}

export interface PortfolioUpdatePayload {
  portfolioId: string;
  totalValue: number;
  change: number;
  changePercent: number;
  timestamp: string;
}

export interface PerformanceUpdatePayload {
  portfolioId: string;
  performance: {
    value: number;
    change: number;
    changePercent: number;
    timeRange: string;
  };
  history: Array<{
    timestamp: string;
    value: number;
  }>;
}

export interface AllocationUpdatePayload {
  portfolioId: string;
  allocation: Array<{
    asset: string;
    percentage: number;
    value: number;
  }>;
  lastUpdated: string;
}

export interface RiskUpdatePayload {
  portfolioId: string;
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
  factors: string[];
  lastUpdated: string;
}

// Error response
export interface WsErrorResponse {
  code: string;
  message: string;
  details?: any;
}

// WebSocket connection statistics
export interface ConnectionStats {
  totalConnections: number;
  activeConnections: number;
  staleConnections: number;
  bufferedEvents: number;
  subscriptions: Map<string, number>;
}

// Health check result
export interface HealthCheckResult {
  status: "healthy" | "degraded" | "unhealthy";
  connections: {
    total: number;
    active: number;
    stale: number;
  };
  lastCheck: string;
  uptime: number;
}

// Reconnection configuration
export interface ReconnectionConfig {
  maxDelay: number; // Maximum delay in ms (30 seconds as per requirement)
  baseDelay: number; // Base delay in ms
  maxAttempts: number; // Maximum reconnection attempts
  factor: number; // Backoff multiplier
}

// Event buffer configuration
export interface EventBufferConfig {
  maxEvents: number; // Maximum events to buffer per user
  maxAge: number; // Maximum age of buffered events in ms
  flushInterval: number; // Interval to check for expired buffers
}
