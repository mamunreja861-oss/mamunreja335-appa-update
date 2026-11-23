import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {execSync} from 'node:child_process';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

function resolveBaseVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {version?: string};
    if (pkg.version && pkg.version !== '0.0.0') {
      return pkg.version;
    }
  } catch {
    // Keep default version
  }
  return '1.1.0';
}

function resolveCommitSha(): string {
  const envSha =
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    process.env.COMMIT_REF?.trim() ||
    '';
  if (envSha) {
    return envSha.slice(0, 7);
  }
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString('utf8')
      .trim()
      .slice(0, 7);
  } catch {
    return '';
  }
}

function formatBuildId(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}.${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
}

export default defineConfig(() => {
  const baseVersion = resolveBaseVersion();
  const builtAt = new Date();
  const builtAtIso = builtAt.toISOString();
  const sha = resolveCommitSha();
  const buildId = sha ? `${formatBuildId(builtAt)}-${sha}` : formatBuildId(builtAt);
  const envOverride = process.env.VITE_APP_VERSION?.trim();
  const appVersion =
    envOverride && envOverride !== baseVersion ? envOverride : `${baseVersion}+${buildId}`;
  process.env.VITE_APP_VERSION = appVersion;

  const versionManifest = JSON.stringify(
    {
      version: appVersion,
      baseVersion,
      buildId,
      builtAt: builtAtIso,
      commitSha: sha || null,
    },
    null,
    2
  );

  return {
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __APP_BASE_VERSION__: JSON.stringify(baseVersion),
      __APP_BUILD_ID__: JSON.stringify(buildId),
      __APP_BUILT_AT__: JSON.stringify(builtAtIso),
    },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'mun-auto-update-version-manifest',
        configureServer(server) {
          server.middlewares.use('/version.json', (_req, res) => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.end(versionManifest);
          });
        },
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          if (fs.existsSync(distDir)) {
            fs.writeFileSync(path.join(distDir, 'version.json'), versionManifest, 'utf8');
          }
        },
      },
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true as const,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
