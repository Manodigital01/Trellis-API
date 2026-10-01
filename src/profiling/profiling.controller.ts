import {
  Controller,
  Get,
  Post,
  Delete,
  Query,
  Param,
  Res,
  HttpException,
  HttpStatus,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Response } from "express";
import * as fs from "fs";
import * as path from "path";
import {
  ProfilingService,
  ProfileMetadata,
  HotFunction,
} from "./profiling.service";
import { RolesGuard } from "../common/guard/roles.guard";
import { Role } from "../common/guard/roles.enum";
import { JwtAuthGuard } from "../core/auth/guards/jwt-auth.guard";
import { Roles } from "../common/guard/roles.decorator";

@Controller("api/v1/profiling")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class ProfilingController {
  private lastHeapSnapshotAt = 0;

  constructor(
    private readonly profilingService: ProfilingService,
    private readonly configService: ConfigService,
  ) {}

  private ensureEnabled() {
    if (
      this.configService.get<string>("NODE_ENV") === "production" &&
      this.configService.get<boolean | string>("ENABLE_PROFILING") !== true &&
      this.configService.get<string>("ENABLE_PROFILING") !== "true"
    ) {
      throw new HttpException("Profiling is disabled", HttpStatus.NOT_FOUND);
    }
  }

  /**
   * Start CPU profiling for a specified duration
   */
  @Post("cpu/start")
  async startCPUProfile(@Query("duration") duration?: string) {
    this.ensureEnabled();
    const durationMs = duration ? parseInt(duration, 10) : 30000;
    return this.profilingService.startCPUProfile(durationMs);
  }

  /**
   * Capture an immediate heap snapshot
   */
  @Post("heap/snapshot")
  async takeHeapSnapshot() {
    this.ensureEnabled();
    if (Date.now() - this.lastHeapSnapshotAt < 15 * 60 * 1000) {
      throw new HttpException("Heap snapshots are limited to once per 15 minutes", HttpStatus.TOO_MANY_REQUESTS);
    }
    this.lastHeapSnapshotAt = Date.now();
    return this.profilingService.takeHeapSnapshot();
  }

  /**
   * List all available profiles
   */
  @Get("profiles")
  listProfiles(): ProfileMetadata[] {
    this.ensureEnabled();
    return this.profilingService.listProfiles();
  }

  /**
   * Download a specific profile file
   */
  @Get("profiles/:id/download")
  downloadProfile(@Param("id") id: string, @Res() res: Response) {
    this.ensureEnabled();
    const filePath = this.profilingService.getProfilePath(id);
    if (!filePath || !fs.existsSync(filePath)) {
      throw new HttpException("Profile not found", HttpStatus.NOT_FOUND);
    }

    const fileName = path.basename(filePath);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.sendFile(filePath);
  }

  /**
   * Delete a profile
   */
  @Delete("profiles/:id")
  deleteProfile(@Param("id") id: string) {
    this.ensureEnabled();
    const success = this.profilingService.deleteProfile(id);
    if (!success) {
      throw new HttpException("Profile not found", HttpStatus.NOT_FOUND);
    }
    return { success: true };
  }

  /**
   * Get hot functions identified by the profiler
   */
  @Get("hot-functions")
  getHotFunctions(): HotFunction[] {
    this.ensureEnabled();
    return this.profilingService.getHotFunctions();
  }

  /**
   * Get request timeline/waterfall data
   */
  @Get("timelines")
  getRequestTimelines() {
    this.ensureEnabled();
    return this.profilingService.getRequestTimelines();
  }

  /**
   * Check for performance regressions
   */
  @Get("regressions/check")
  checkRegressions() {
    this.ensureEnabled();
    const regressions = this.profilingService.checkPerformanceRegressions();
    return {
      regressions,
      baselineEstablished: !!this.profilingService["baselineMetrics"],
    };
  }

  /**
   * Get current memory statistics
   */
  @Get("memory/stats")
  getMemoryStats() {
    this.ensureEnabled();
    return this.profilingService.getMemoryStats();
  }

  /**
   * Serve profiling visualization UI
   */
  @Get("ui")
  serveProfilingUI(@Res() res: Response) {
    this.ensureEnabled();
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Trellis Performance Profiler</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #1a1a2e; color: #eee; }
    .container { max-width: 1200px; margin: 0 auto; }
    .card { background: #16213e; padding: 20px; margin: 15px 0; border-radius: 8px; }
    .btn { background: #e94560; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; margin: 5px; }
    .btn:hover { background: #ff6b6b; }
    .metric { background: #0f3460; padding: 15px; margin: 10px 0; border-radius: 4px; }
    .status { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    .status.completed { background: #4ade80; color: #000; }
    .status.active { background: #fbbf24; color: #000; }
    .status.failed { background: #ef4444; color: #fff; }
    pre { background: #0a0a0f; padding: 15px; border-radius: 4px; overflow-x: auto; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 Trellis Performance Profiler</h1>
    
    <div class="card">
      <h2>Quick Actions</h2>
      <button class="btn" onclick="startCPUProfile()">Start CPU Profile (30s)</button>
      <button class="btn" onclick="takeHeapSnapshot()">Take Heap Snapshot</button>
      <button class="btn" onclick="refreshAll()">Refresh Data</button>
    </div>

    <div class="grid">
      <div class="card">
        <h2>📊 Memory Stats</h2>
        <div id="memoryStats"></div>
      </div>
      
      <div class="card">
        <h2>⚠️ Performance Regressions</h2>
        <div id="regressions"></div>
      </div>
    </div>

    <div class="card">
      <h2>🔥 Top Hot Functions</h2>
      <div id="hotFunctions"></div>
    </div>

    <div class="card">
      <h2>💾 Saved Profiles</h2>
      <div id="profilesList"></div>
    </div>

    <div class="card">
      <h2>📈 Request Timelines</h2>
      <div id="timelines"></div>
    </div>
  </div>

  <script>
    async function fetchAPI(endpoint) {
      const res = await fetch('/api/v1/profiling' + endpoint);
      return res.json();
    }

    async function refreshMemoryStats() {
      const stats = await fetchAPI('/memory/stats');
      document.getElementById('memoryStats').innerHTML = \`
        <div class="metric">
          <strong>Memory Usage:</strong> \${stats.percentUsed}<br>
          <small>Used: \${(stats.usedHeapSize / 1024 / 1024).toFixed(2)}MB / \${(stats.heapSizeLimit / 1024 / 1024).toFixed(2)}MB</small>
        </div>
      \`;
    }

    async function refreshRegressions() {
      const data = await fetchAPI('/regressions/check');
      const regressionsHtml = data.regressions.length > 0 
        ? data.regressions.map(r => '<div class="metric" style="background:#ef444440">' + r + '</div>').join('')
        : '<div class="metric" style="background:#4ade8040">✅ No regressions detected</div>';
      document.getElementById('regressions').innerHTML = regressionsHtml;
    }

    async function refreshHotFunctions() {
      const funcs = await fetchAPI('/hot-functions');
      const html = funcs.slice(0, 10).map(f => \`
        <div class="metric">
          <strong>\${f.name}</strong><br>
          <small>Calls: \${f.callCount} | Avg: \${f.selfTime.toFixed(2)}ms | Total: \${f.totalTime.toFixed(2)}ms</small>
        </div>
      \`).join('');
      document.getElementById('hotFunctions').innerHTML = html || '<p>No function data collected yet</p>';
    }

    async function refreshProfiles() {
      const profiles = await fetchAPI('/profiles');
      const html = profiles.map(p => \`
        <div class="metric">
          <span class="status \${p.status}">\${p.status}</span>
          <strong>\${p.id}</strong> [\${p.type}]<br>
          <small>Size: \${(p.size / 1024 / 1024).toFixed(2)}MB | Created: \${new Date(p.startTime).toLocaleString()}</small>
          <br>
          \${p.status === 'completed' ? \`<a href="/api/v1/profiling/profiles/\${p.id}/download" class="btn" style="display:inline-block;margin-top:10px;text-decoration:none">Download</a>\` : ''}
          <button class="btn" onclick="deleteProfile('\${p.id}')" style="background:#666">Delete</button>
        </div>
      \`).join('');
      document.getElementById('profilesList').innerHTML = html || '<p>No profiles created yet</p>';
    }

    async function refreshTimelines() {
      const timelines = await fetchAPI('/timelines');
      const html = timelines.slice(0, 20).map(t => \`
        <div class="metric">
          <strong>\${t.name}</strong><br>
          <small>Start: \${t.startTime.toFixed(2)}ms | Duration: \${t.duration.toFixed(2)}ms</small>
        </div>
      \`).join('');
      document.getElementById('timelines').innerHTML = html || '<p>No timeline data collected yet</p>';
    }

    async function startCPUProfile() {
      await fetchAPI('/cpu/start');
      alert('CPU profiling started for 30 seconds');
      refreshAll();
    }

    async function takeHeapSnapshot() {
      await fetchAPI('/heap/snapshot');
      alert('Heap snapshot captured');
      refreshAll();
    }

    async function deleteProfile(id) {
      await fetch('/api/v1/profiling/profiles/' + id, { method: 'DELETE' });
      refreshAll();
    }

    function refreshAll() {
      refreshMemoryStats();
      refreshRegressions();
      refreshHotFunctions();
      refreshProfiles();
      refreshTimelines();
    }

    // Initial load
    refreshAll();
    // Auto-refresh every 5 seconds
    setInterval(refreshAll, 5000);
  </script>
</body>
</html>`;
    res.send(html);
  }
}
