import { Worker } from "worker_threads";
import { Injectable, Logger } from "@nestjs/common";

export interface WorkerExecutionOptions {
  timeoutMs?: number;
  maxMemoryMb?: number;
}

export interface MonteCarloSimulationParams {
  numSimulations: number;
  timeHorizonDays: number;
  initialValue: number;
  expectedReturns: number[];
  volatilities: number[];
  weights: number[];
  correlationMatrix?: number[][];
}

export interface MonteCarloSimulationResult {
  simulationsRun: number;
  expectedEndingValue: number;
  medianEndingValue: number;
  var95: number;
  cvar95: number;
  sharpeRatio: number;
  percentiles: {
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
  };
  durationMs: number;
}

/**
 * Inline worker script executing heavy Monte Carlo simulations and mathematical calculations.
 */
const WORKER_SCRIPT = `
const { parentPort, workerData } = require('worker_threads');

function gaussianRandom() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function runMonteCarlo(params) {
  const {
    numSimulations = 10000,
    timeHorizonDays = 252,
    initialValue = 100000,
    expectedReturns = [0.08],
    volatilities = [0.15],
    weights = [1.0],
  } = params;

  const dt = 1 / 252;
  const portfolioDrift = weights.reduce((acc, w, i) => acc + w * (expectedReturns[i] || 0.05), 0);
  const portfolioVol = Math.sqrt(
    weights.reduce((acc, w, i) => acc + (w * (volatilities[i] || 0.15)) ** 2, 0)
  );

  const endingValues = new Float64Array(numSimulations);

  for (let s = 0; s < numSimulations; s++) {
    let value = initialValue;
    for (let day = 0; day < timeHorizonDays; day++) {
      const z = gaussianRandom();
      const returnDaily = (portfolioDrift - 0.5 * (portfolioVol ** 2)) * dt + portfolioVol * Math.sqrt(dt) * z;
      value *= Math.exp(returnDaily);
    }
    endingValues[s] = value;
  }

  // Calculate statistics
  endingValues.sort();
  const sum = endingValues.reduce((a, b) => a + b, 0);
  const mean = sum / numSimulations;
  const median = endingValues[Math.floor(numSimulations * 0.5)];

  const p5 = endingValues[Math.floor(numSimulations * 0.05)];
  const p25 = endingValues[Math.floor(numSimulations * 0.25)];
  const p50 = median;
  const p75 = endingValues[Math.floor(numSimulations * 0.75)];
  const p95 = endingValues[Math.floor(numSimulations * 0.95)];

  // VaR 95%: initial - 5th percentile
  const var95 = Math.max(0, initialValue - p5);

  // CVaR (Expected Shortfall) 95%
  const tailCount = Math.floor(numSimulations * 0.05);
  let tailSum = 0;
  for (let i = 0; i < tailCount; i++) {
    tailSum += endingValues[i];
  }
  const cvar95 = Math.max(0, initialValue - (tailCount > 0 ? tailSum / tailCount : p5));

  const totalReturn = (mean - initialValue) / initialValue;
  const sharpeRatio = portfolioVol > 0 ? (totalReturn - 0.02) / portfolioVol : 0;

  return {
    simulationsRun: numSimulations,
    expectedEndingValue: Math.round(mean * 100) / 100,
    medianEndingValue: Math.round(median * 100) / 100,
    var95: Math.round(var95 * 100) / 100,
    cvar95: Math.round(cvar95 * 100) / 100,
    sharpeRatio: Math.round(sharpeRatio * 1000) / 1000,
    percentiles: {
      p5: Math.round(p5 * 100) / 100,
      p25: Math.round(p25 * 100) / 100,
      p50: Math.round(p50 * 100) / 100,
      p75: Math.round(p75 * 100) / 100,
      p95: Math.round(p95 * 100) / 100,
    },
  };
}

function executeTask(task) {
  const { type, payload } = task;
  if (type === 'monte-carlo') {
    return runMonteCarlo(payload);
  } else if (type === 'custom-eval') {
    // Execute computational function body
    const fn = new Function('data', payload.code);
    return fn(payload.data);
  } else if (type === 'infinite-loop-test') {
    // Loop continuously to test timeout cancellation
    while (true) {}
  } else if (type === 'memory-overflow-test') {
    // Allocate heavy arrays to test memory limit enforcement
    const buffers = [];
    while (true) {
      buffers.push(new Array(1000000).fill(Math.random()));
    }
  } else {
    throw new Error('Unknown simulation task type: ' + type);
  }
}

try {
  const result = executeTask(workerData);
  parentPort.postMessage({ success: true, result });
} catch (error) {
  parentPort.postMessage({ success: false, error: error.message || String(error) });
}
`;

@Injectable()
export class SimulationWorkerRunner {
  private readonly logger = new Logger(SimulationWorkerRunner.name);
  private readonly defaultTimeoutMs = 30000; // 30 seconds default
  private readonly defaultMaxMemoryMb = 128; // 128MB max heap per worker

  /**
   * Run Monte Carlo simulation in an isolated worker thread with memory limit and timeout.
   */
  async runMonteCarloSimulation(
    params: MonteCarloSimulationParams,
    options?: WorkerExecutionOptions,
  ): Promise<MonteCarloSimulationResult> {
    const startTime = Date.now();
    const result = await this.executeInWorker<MonteCarloSimulationResult>(
      { type: "monte-carlo", payload: params },
      options,
    );
    return {
      ...result,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Run an arbitrary heavy computational task in an isolated worker thread.
   */
  async executeInWorker<T>(
    task: { type: string; payload?: any },
    options?: WorkerExecutionOptions,
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const maxMemoryMb = options?.maxMemoryMb ?? this.defaultMaxMemoryMb;

    return new Promise<T>((resolve, reject) => {
      let isSettled = false;
      let timeoutTimer: NodeJS.Timeout | null = null;

      const worker = new Worker(WORKER_SCRIPT, {
        eval: true,
        workerData: task,
        resourceLimits: {
          maxOldGenerationSizeMb: maxMemoryMb,
          maxYoungGenerationSizeMb: Math.max(16, Math.floor(maxMemoryMb / 4)),
        },
      });

      const cleanup = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
      };

      timeoutTimer = setTimeout(async () => {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          try {
            await worker.terminate();
          } catch {
            // Worker already dead
          }
          this.logger.warn(`Worker simulation timed out after ${timeoutMs}ms`);
          reject(
            new Error(
              `Simulation exceeded maximum execution time of ${timeoutMs}ms`,
            ),
          );
        }
      }, timeoutMs);

      // Avoid holding open event loop if worker completes
      if (typeof timeoutTimer.unref === "function") {
        timeoutTimer.unref();
      }

      worker.on(
        "message",
        (msg: { success: boolean; result?: T; error?: string }) => {
          if (isSettled) return;
          isSettled = true;
          cleanup();

          if (msg.success) {
            resolve(msg.result as T);
          } else {
            reject(
              new Error(msg.error || "Simulation worker execution failed"),
            );
          }
        },
      );

      worker.on("error", (err: Error) => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        this.logger.error(`Worker thread error: ${err.message}`);
        reject(err);
      });

      worker.on("exit", (code: number) => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        if (code !== 0) {
          reject(
            new Error(
              `Simulation worker stopped unexpectedly with exit code ${code}`,
            ),
          );
        }
      });
    });
  }
}
