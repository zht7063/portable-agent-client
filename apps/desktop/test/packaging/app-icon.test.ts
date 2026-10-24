import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const app = join(__dirname, '..', '..');
process.env.PA_LOCAL_BUILD = '1';

const png = (f: string) => { const b = readFileSync(join(app, f)); return { sig: b.subarray(1, 4).toString(), w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };

describe('swift-client app icon', () => {
  it('generated icon files exist with the expected formats and sizes', () => {
    expect(existsSync(join(app, 'build/icon-source.jpeg'))).toBe(true);
    expect(png('build/icon.png')).toEqual({ sig: 'PNG', w: 1024, h: 1024 });
    expect(png('build/icon-window.png')).toEqual({ sig: 'PNG', w: 256, h: 256 });
    for (const n of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) expect(png(`build/icons/${n}x${n}.png`)).toEqual({ sig: 'PNG', w: n, h: n });
    const icns = readFileSync(join(app, 'build/icon.icns'));
    expect(icns.subarray(0, 4).toString()).toBe('icns');
    const types: string[] = [];
    for (let i = 8; i < icns.length; i += icns.readUInt32BE(i + 4)) types.push(icns.subarray(i, i + 4).toString());
    expect(types.sort()).toEqual(['ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14', 'icp4', 'icp5']);
    const ico = readFileSync(join(app, 'build/icon.ico'));
    expect(ico.readUInt16LE(2)).toBe(1);
    const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, k) => ico[6 + k * 16] || 256).sort((a, b) => a - b);
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256]);
  });

  it('electron-builder uses the icons for the app, dmg, NSIS installer and Linux', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require(join(app, 'electron-builder.config.cjs')) as Record<string, Record<string, unknown>>;
    expect(cfg.directories!.buildResources).toBe('build');
    expect(cfg.mac!.icon).toBe('build/icon.icns');
    expect(cfg.dmg!.icon).toBe('build/icon.icns');
    expect(cfg.win!.icon).toBe('build/icon.ico');
    expect(cfg.nsis!.installerIcon).toBe('build/icon.ico');
    expect(cfg.nsis!.uninstallerIcon).toBe('build/icon.ico');
    expect(cfg.linux!.icon).toBe('build/icons');
  });

  it('the BrowserWindow gets the PNG icon on Windows/Linux and build-main ships it in dist/', () => {
    expect(readFileSync(join(app, 'src/main/index.ts'), 'utf8')).toContain("icon: join(__dirname, '../icon.png')");
    expect(readFileSync(join(app, 'scripts/build-main.mjs'), 'utf8')).toContain("copyFileSync(join(app, 'build/icon-window.png'), join(out, 'icon.png'))");
  });
});
