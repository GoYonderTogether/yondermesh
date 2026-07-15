import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

import {
  MENUBAR_AGENT_LABEL,
  resolveMenuBarAppPath,
  resolveMenuBarExecutable,
  resolveMenuBarPlist,
  generateMenuBarPlist,
  generateMenuBarInfoPlist,
  buildMenuBarApp,
} from '../src/install/menubar.js';

function hasSwiftc(): boolean {
  try {
    execSync('swiftc --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const SWIFTC_AVAILABLE = hasSwiftc();

describe('menubar: path resolution', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-mb-'));
    process.env.YONDERMESH_HOME = tmpHome;
  });

  afterEach(() => {
    delete process.env.YONDERMESH_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('MENUBAR_AGENT_LABEL is correct', () => {
    expect(MENUBAR_AGENT_LABEL).toBe('com.yondermesh.menubar');
  });

  it('resolveMenuBarAppPath is under data dir', () => {
    const appPath = resolveMenuBarAppPath();
    expect(appPath).toBe(path.join(tmpHome, 'YondermeshMenuBar.app'));
  });

  it('resolveMenuBarExecutable points to Contents/MacOS', () => {
    const execPath = resolveMenuBarExecutable();
    expect(execPath).toBe(
      path.join(tmpHome, 'YondermeshMenuBar.app', 'Contents', 'MacOS', 'YondermeshMenuBar'),
    );
  });

  it('resolveMenuBarPlist is under ~/Library/LaunchAgents/', () => {
    const plistPath = resolveMenuBarPlist();
    expect(plistPath).toContain('Library/LaunchAgents');
    expect(plistPath).toContain('com.yondermesh.menubar.plist');
  });
});

describe('menubar: plist generation', () => {
  it('generateMenuBarPlist outputs valid plist XML', () => {
    const plist = generateMenuBarPlist();
    expect(plist).toContain('<?xml');
    expect(plist).toContain('<plist');
    expect(plist).toContain(MENUBAR_AGENT_LABEL);
    expect(plist).toContain('ProgramArguments');
    expect(plist).toContain('RunAtLoad');
  });

  it('generateMenuBarPlist RunAtLoad=true', () => {
    const plist = generateMenuBarPlist();
    const raMatch = plist.match(/<key>RunAtLoad<\/key>\s*<(\w+)\/??>/);
    expect(raMatch).toBeTruthy();
    expect(raMatch![1]).toBe('true');
  });

  it('generateMenuBarPlist does NOT contain KeepAlive', () => {
    const plist = generateMenuBarPlist();
    expect(plist).not.toContain('KeepAlive');
  });

  it('generateMenuBarPlist contains ThrottleInterval', () => {
    const plist = generateMenuBarPlist();
    expect(plist).toContain('ThrottleInterval');
  });

  it('generateMenuBarPlist ProgramArguments points to menubar executable', () => {
    const plist = generateMenuBarPlist();
    expect(plist).toContain('YondermeshMenuBar');
    expect(plist).toContain('Contents/MacOS/YondermeshMenuBar');
  });

  it('generateMenuBarInfoPlist outputs valid Info.plist', () => {
    const info = generateMenuBarInfoPlist();
    expect(info).toContain('<?xml');
    expect(info).toContain('CFBundleName');
    expect(info).toContain('YondermeshMenuBar');
    expect(info).toContain('CFBundleExecutable');
    expect(info).toContain('LSUIElement');
  });

  it('generateMenuBarInfoPlist LSUIElement=true', () => {
    const info = generateMenuBarInfoPlist();
    const uiMatch = info.match(/<key>LSUIElement<\/key>\s*<(\w+)\/??>/);
    expect(uiMatch).toBeTruthy();
    expect(uiMatch![1]).toBe('true');
  });
});

describe('menubar: build .app bundle', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-mb-build-'));
    process.env.YONDERMESH_HOME = tmpHome;
  });

  afterEach(() => {
    delete process.env.YONDERMESH_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it.skipIf(!SWIFTC_AVAILABLE)('buildMenuBarApp creates valid .app bundle', () => {
    const projectRoot = path.resolve(__dirname, '..');
    const swiftSource = path.join(projectRoot, 'src', 'menubar', 'YondermeshMenuBar.swift');
    expect(fs.existsSync(swiftSource)).toBe(true);

    buildMenuBarApp(swiftSource);

    const appPath = resolveMenuBarAppPath();
    expect(fs.existsSync(appPath)).toBe(true);
    expect(fs.existsSync(resolveMenuBarExecutable())).toBe(true);
    expect(fs.existsSync(path.join(appPath, 'Contents', 'Info.plist'))).toBe(true);

    const stat = fs.statSync(resolveMenuBarExecutable());
    expect(stat.mode & 0o111).toBeTruthy();
  });

  it.skipIf(!SWIFTC_AVAILABLE)('buildMenuBarApp is idempotent', () => {
    const projectRoot = path.resolve(__dirname, '..');
    const swiftSource = path.join(projectRoot, 'src', 'menubar', 'YondermeshMenuBar.swift');

    buildMenuBarApp(swiftSource);
    buildMenuBarApp(swiftSource);

    expect(fs.existsSync(resolveMenuBarExecutable())).toBe(true);
  });
});

describe('menubar: binary target version', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ymesh-mb-ver-'));
    process.env.YONDERMESH_HOME = tmpHome;
  });

  afterEach(() => {
    delete process.env.YONDERMESH_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it.skipIf(!SWIFTC_AVAILABLE)('compiled binary minOS matches current macOS major version', () => {
    const projectRoot = path.resolve(__dirname, '..');
    const swiftSource = path.join(projectRoot, 'src', 'menubar', 'YondermeshMenuBar.swift');
    buildMenuBarApp(swiftSource);

    const execPath = resolveMenuBarExecutable();
    const otoolOutput = execSync(`otool -l "${execPath}"`, { encoding: 'utf-8' });

    // Should have LC_BUILD_VERSION with minos <= current macOS version
    const minosMatch = otoolOutput.match(/LC_BUILD_VERSION[\s\S]*?minos\s+(\d+)/);
    expect(minosMatch).toBeTruthy();

    const swVers = execSync('sw_vers -productVersion', { encoding: 'utf-8' }).trim();
    const currentMajor = parseInt(swVers.split('.')[0], 10);
    const binaryMinOS = parseInt(minosMatch![1], 10);

    // Binary should not require a newer macOS than we're running
    expect(binaryMinOS).toBeLessThanOrEqual(currentMajor);
  });
});
