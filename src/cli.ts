import { Command } from "commander";
import { VERSION } from "./server.js";
import { fail } from "./ui.js";
import {
  addCommand,
  editCommand,
  initCommand,
  listCommand,
  menuCommand,
  reloadCommand,
  removeCommand,
  serveCommand,
  startCommand,
  statusCommand,
  stopCommand,
  useCommand,
} from "./commands.js";
import { startTui } from "./tui/index.js";

async function run(fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const e = err as Error & { name?: string };
    if (e.name === "ExitPromptError") process.exit(130);
    fail(e.message);
    process.exit(1);
  }
}

const program = new Command();

program
  .name("llmwarp")
  .description("本地 OpenAI 协议路由，随时切换 LLM API 供应商")
  .version(VERSION, "-v, --version");

program
  .command("init")
  .description("生成带注释的示例配置")
  .option("--force", "覆盖已存在的配置")
  .action((opts: { force?: boolean }) => run(() => initCommand(opts)));

program.command("add").description("向导式新增供应商").action(() => run(addCommand));

program
  .command("edit [provider]")
  .description("编辑供应商，或用 --file 打开配置文件")
  .option("--file", "用 $EDITOR 打开配置文件")
  .action((provider: string | undefined, opts: { file?: boolean }) =>
    run(() => editCommand(provider, opts)),
  );

program
  .command("list")
  .alias("ls")
  .description("列出供应商并检查可用性")
  .option("--offline", "不检查可用性（更快）")
  .action((opts: { offline?: boolean }) => run(() => listCommand(opts)));

program
  .command("use [provider]")
  .description("切换供应商/模型")
  .option("--model <model>", "直接指定模型")
  .option("--list", "列出该供应商的模型")
  .option("--refresh", "重新查询 <baseUrl>/models")
  .action((provider: string | undefined, opts: { model?: string; list?: boolean; refresh?: boolean }) =>
    run(() => useCommand(provider, opts)),
  );

program.command("status").alias("st").description("查看当前状态").action(() => run(statusCommand));
program.command("tui").description("打开常驻管理界面").action(() => run(startTui));
program
  .command("remove [provider]")
  .alias("rm")
  .description("移除供应商")
  .action((provider: string | undefined) => run(() => removeCommand(provider)));

program.command("reload").description("让守护进程重载配置").action(() => run(reloadCommand));

program
  .command("serve")
  .description("前台运行守护进程")
  .option("--port <n>", "端口", (v) => parseInt(v, 10))
  .action((opts: { port?: number }) => run(() => serveCommand(opts.port)));

program.command("start").description("后台启动守护进程").action(() => run(startCommand));
program.command("stop").description("停止守护进程").action(() => run(stopCommand));

program.action(() => run(menuCommand));

program.parseAsync().catch((err: Error) => {
  fail(err.message);
  process.exit(1);
});
