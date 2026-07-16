import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { loadUnifiedConfig } from "#src/config-loader";
import { registerPermissionSystemCommand } from "#src/config-modal";
import type { CommandConfigStore } from "#src/config-store";
import {
  DEFAULT_EXTENSION_CONFIG,
  normalizePermissionSystemConfig,
  type PermissionSystemExtensionConfig,
} from "#src/extension-config";
import type { Rule, Ruleset } from "#src/rule";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getSettingsListTheme: () => ({}),
}));

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class {
    handleInput(): void {}
    updateValue(): void {}
    render(): string[] {
      return [];
    }
    invalidate(): void {}
  },
}));

type Notification = { message: string; level: "info" | "warning" | "error" };

type CommandContextStub = {
  hasUI: boolean;
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    custom<T>(
      renderer: (...args: unknown[]) => unknown,
      options?: unknown,
    ): Promise<T>;
  };
};

function createCommandContext(hasUI: boolean): {
  ctx: CommandContextStub;
  notifications: Notification[];
  getCustomCalls(): number;
} {
  const notifications: Notification[] = [];
  let customCalls = 0;

  return {
    ctx: {
      hasUI,
      ui: {
        notify(message: string, level: "info" | "warning" | "error") {
          notifications.push({ message, level });
        },
        async custom<T>(
          _renderer: (...args: unknown[]) => unknown,
          _options?: unknown,
        ): Promise<T> {
          customCalls += 1;
          return undefined as T;
        },
      },
    },
    notifications,
    getCustomCalls: () => customCalls,
  };
}

function lastNotification(notifications: Notification[]): Notification {
  return notifications[notifications.length - 1];
}

test("permission-system command completions expose top-level config actions", () => {
  const baseDir = mkdtempSync(
    join(tmpdir(), "pi-permission-system-command-completions-"),
  );
  const configPath = join(baseDir, "config.json");
  let config: PermissionSystemExtensionConfig = { ...DEFAULT_EXTENSION_CONFIG };

  try {
    const configStore: CommandConfigStore = {
      current: () => config,
      save: (next) => {
        config = next;
      },
      setSessionYoloMode: (next) => {
        config = { ...config, yoloMode: next };
      },
    };
    const controller = {
      config: configStore,
      configPath,
      getActiveAgentConfigRules: () => [] as Ruleset,
    };

    let definition: {
      description: string;
      getArgumentCompletions?: (
        argumentPrefix: string,
      ) => Array<{ value: string; label: string; description?: string }> | null;
      handler: (args: string, ctx: CommandContextStub) => Promise<void>;
    } | null = null;

    registerPermissionSystemCommand(
      {
        registerCommand(_name: string, nextDefinition: typeof definition) {
          definition = nextDefinition;
        },
      } as never,
      controller,
    );

    expect(definition!.getArgumentCompletions).toBeTypeOf("function");

    const topLevel = definition!.getArgumentCompletions?.("");
    expect(Array.isArray(topLevel)).toBeTruthy();
    expect(topLevel?.some((item) => item.value === "show")).toBeTruthy();
    expect(topLevel?.some((item) => item.value === "reset")).toBeTruthy();

    const filtered = definition!.getArgumentCompletions?.("pa");
    expect(filtered?.map((item) => item.value)).toEqual(["path"]);
    expect(definition!.getArgumentCompletions?.("path extra")).toBe(null);
    expect(definition!.getArgumentCompletions?.("zzz")).toBe(null);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("yolo command toggles yoloMode and accepts explicit on/off", async () => {
  let config: PermissionSystemExtensionConfig = { ...DEFAULT_EXTENSION_CONFIG };
  const save = vi.fn((next: PermissionSystemExtensionConfig) => {
    config = next;
  });
  const configStore: CommandConfigStore = {
    current: () => config,
    save,
    setSessionYoloMode: (next) => {
      config = { ...config, yoloMode: next };
    },
  };
  const controller = {
    config: configStore,
    configPath: "/fake/config.json",
    getActiveAgentConfigRules: () => [] as Ruleset,
  };

  type RegisteredCommand = {
    description: string;
    getArgumentCompletions?: (
      argumentPrefix: string,
    ) => Array<{ value: string; label: string; description?: string }> | null;
    handler: (args: string, ctx: CommandContextStub) => Promise<void>;
  };
  const commands = new Map<string, RegisteredCommand>();

  registerPermissionSystemCommand(
    {
      registerCommand(name: string, definition: RegisteredCommand) {
        commands.set(name, definition);
      },
    } as never,
    controller,
  );

  const yolo = commands.get("yolo");
  expect(yolo).toBeDefined();
  if (!yolo) throw new Error("/yolo command was not registered");
  expect(yolo.description).toContain("YOLO");
  expect(yolo.getArgumentCompletions?.("o")?.map((item) => item.value)).toEqual(
    ["on", "off"],
  );

  const ctx = createCommandContext(true);
  await yolo.handler("", ctx.ctx);
  expect(config.yoloMode).toBe(true);
  expect(lastNotification(ctx.notifications).message).toBe(
    "YOLO mode on for this session.",
  );
  expect(save).not.toHaveBeenCalled();

  await yolo.handler("", ctx.ctx);
  expect(config.yoloMode).toBe(false);
  expect(lastNotification(ctx.notifications).message).toBe(
    "YOLO mode off for this session.",
  );

  await yolo.handler("on", ctx.ctx);
  expect(config.yoloMode).toBe(true);

  await yolo.handler("off", ctx.ctx);
  expect(config.yoloMode).toBe(false);

  await yolo.handler("wat", ctx.ctx);
  expect(config.yoloMode).toBe(false);
  expect(lastNotification(ctx.notifications).level).toBe("warning");
  expect(lastNotification(ctx.notifications).message).toContain("Usage: /yolo");
});

test("permission-system command handlers manage config summary, persistence, and modal routing", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-command-"));
  const configPath = join(baseDir, "config.json");
  let config: PermissionSystemExtensionConfig = {
    debugLog: true,
    permissionReviewLog: false,
    yoloMode: true,
  };

  try {
    writeFileSync(
      configPath,
      `${JSON.stringify(normalizePermissionSystemConfig(config), null, 2)}\n`,
      "utf-8",
    );

    const configStore: CommandConfigStore = {
      current: () => config,
      save: (next) => {
        const currentConfig = normalizePermissionSystemConfig(
          loadUnifiedConfig(configPath).config,
        );
        const normalized = normalizePermissionSystemConfig(next);
        writeFileSync(
          configPath,
          `${JSON.stringify(normalized, null, 2)}\n`,
          "utf-8",
        );
        config = normalizePermissionSystemConfig(
          loadUnifiedConfig(configPath).config,
        );
        expect(config).not.toEqual(currentConfig);
      },
      setSessionYoloMode: (next) => {
        config = { ...config, yoloMode: next };
      },
    };
    const controller = {
      config: configStore,
      configPath,
      getActiveAgentConfigRules: () => [] as Ruleset,
    };

    let registeredName = "";
    let definition: {
      description: string;
      getArgumentCompletions?: (
        argumentPrefix: string,
      ) => Array<{ value: string; label: string; description?: string }> | null;
      handler: (args: string, ctx: CommandContextStub) => Promise<void>;
    } | null = null;

    registerPermissionSystemCommand(
      {
        registerCommand(name: string, nextDefinition: typeof definition) {
          registeredName = name;
          definition = nextDefinition;
        },
      } as never,
      controller,
    );

    expect(registeredName).toBe("permission-system");
    expect(definition!.description).toContain("Configure pi-permission-system");

    const infoCtx = createCommandContext(true);
    await definition!.handler("show", infoCtx.ctx);
    expect(lastNotification(infoCtx.notifications).message).toContain(
      "yoloMode=on",
    );
    expect(lastNotification(infoCtx.notifications).message).toContain(
      "debugLog=on",
    );

    await definition!.handler("path", infoCtx.ctx);
    expect(lastNotification(infoCtx.notifications).message).toBe(
      `permission-system config: ${configPath}`,
    );

    await definition!.handler("help", infoCtx.ctx);
    expect(lastNotification(infoCtx.notifications).message).toContain(
      "Usage: /permission-system",
    );

    await definition!.handler("reset", infoCtx.ctx);
    expect(config).toEqual(DEFAULT_EXTENSION_CONFIG);
    expect(lastNotification(infoCtx.notifications).message).toBe(
      "Permission system settings reset to defaults.",
    );

    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(persisted).toEqual(DEFAULT_EXTENSION_CONFIG);

    await definition!.handler("unknown", infoCtx.ctx);
    expect(lastNotification(infoCtx.notifications).level).toBe("warning");
    expect(lastNotification(infoCtx.notifications).message).toContain(
      "Usage: /permission-system",
    );

    const headlessCtx = createCommandContext(false);
    await definition!.handler("", headlessCtx.ctx);
    expect(lastNotification(headlessCtx.notifications).message).toBe(
      "/permission-system requires interactive TUI mode.",
    );

    const modalCtx = createCommandContext(true);
    await definition!.handler("", modalCtx.ctx);
    expect(modalCtx.getCustomCalls()).toBe(1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("show output includes rule origins when getComposedRules is provided", async () => {
  const config = { ...DEFAULT_EXTENSION_CONFIG };
  const composedRules: Rule[] = [
    {
      surface: "read",
      pattern: "*",
      action: "allow",
      layer: "config",
      origin: "global",
    },
    {
      surface: "bash",
      pattern: "rm *",
      action: "deny",
      layer: "config",
      origin: "project",
    },
  ];

  const controller = {
    config: {
      current: () => config,
      save: () => {},
      setSessionYoloMode: () => {},
    } as CommandConfigStore,
    configPath: "/fake/config.json",
    getActiveAgentConfigRules: () => composedRules,
  };

  let definition: {
    handler: (args: string, ctx: CommandContextStub) => Promise<void>;
  } | null = null;

  registerPermissionSystemCommand(
    {
      registerCommand(_name: string, nextDef: typeof definition) {
        definition = nextDef;
      },
    } as never,
    controller,
  );

  const ctx = createCommandContext(true);
  await definition!.handler("show", ctx.ctx);
  const msg = lastNotification(ctx.notifications).message;

  expect(msg).toContain("global");
  expect(msg).toContain("project");
  expect(msg).toContain("read");
  expect(msg).toContain("bash");
});

test("show output omits rule summary when getComposedRules is not provided", async () => {
  const config = { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true };

  const controller = {
    config: {
      current: () => config,
      save: () => {},
      setSessionYoloMode: () => {},
    } as CommandConfigStore,
    configPath: "/fake/config.json",
    getActiveAgentConfigRules: () => [] as Ruleset,
  };

  let definition: {
    handler: (args: string, ctx: CommandContextStub) => Promise<void>;
  } | null = null;

  registerPermissionSystemCommand(
    {
      registerCommand(_name: string, nextDef: typeof definition) {
        definition = nextDef;
      },
    } as never,
    controller,
  );

  const ctx = createCommandContext(true);
  await definition!.handler("show", ctx.ctx);
  const msg = lastNotification(ctx.notifications).message;

  // Config knobs still present.
  expect(msg).toContain("yoloMode=on");
  // No rule annotation lines.
  expect(msg).not.toContain("(global)");
});
