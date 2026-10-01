import { SimulationWorkerRunner } from "./simulation-worker-runner";

describe("SimulationWorkerRunner", () => {
  let runner: SimulationWorkerRunner;

  beforeEach(() => {
    runner = new SimulationWorkerRunner();
  });

  it("executes Monte Carlo simulations in a worker thread and returns statistical metrics", async () => {
    const result = await runner.runMonteCarloSimulation(
      {
        numSimulations: 500,
        timeHorizonDays: 30,
        initialValue: 10000,
        expectedReturns: [0.1],
        volatilities: [0.2],
        weights: [1.0],
      },
      { timeoutMs: 5000 },
    );

    expect(result.simulationsRun).toBe(500);
    expect(result.expectedEndingValue).toBeGreaterThan(0);
    expect(result.medianEndingValue).toBeGreaterThan(0);
    expect(result.percentiles.p5).toBeLessThanOrEqual(result.percentiles.p50);
    expect(result.percentiles.p50).toBeLessThanOrEqual(result.percentiles.p95);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not block the main event loop during heavy simulation computation", async () => {
    let heartbeats = 0;
    const interval = setInterval(() => {
      heartbeats++;
    }, 10);

    const simulationPromise = runner.runMonteCarloSimulation(
      {
        numSimulations: 2000,
        timeHorizonDays: 100,
        initialValue: 50000,
        expectedReturns: [0.08, 0.12],
        volatilities: [0.15, 0.25],
        weights: [0.6, 0.4],
      },
      { timeoutMs: 10000 },
    );

    await simulationPromise;
    clearInterval(interval);

    // Event loop heartbeats must have fired concurrently
    expect(heartbeats).toBeGreaterThan(0);
  });

  it("automatically terminates runaway simulations that exceed timeout limit", async () => {
    const timeoutMs = 200; // Fast timeout for test

    await expect(
      runner.executeInWorker({ type: "infinite-loop-test" }, { timeoutMs }),
    ).rejects.toThrow(
      `Simulation exceeded maximum execution time of ${timeoutMs}ms`,
    );
  });

  it("terminates simulation tasks that exceed memory usage limit", async () => {
    // 32MB max memory
    await expect(
      runner.executeInWorker(
        { type: "memory-overflow-test" },
        { timeoutMs: 5000, maxMemoryMb: 32 },
      ),
    ).rejects.toThrow();
  });
});
