"use strict";

const stateDir = "/data/adb/omk";
const configDir = "/data/misc/keystore/omk";
const moduleDir = "/data/adb/modules/oh_my_keymint";
const refresh = document.querySelector("#refresh");
const summary = document.querySelector("#summary");
const notice = document.querySelector("#notice");
const confirm = document.querySelector("#confirm");
const actions = [...document.querySelectorAll("[data-restart]")];
const restartLabels = { keymint: "KeyMint", injector: "Injector", all: "全部服务" };
let restartTarget;
let callbackId = 0;

function exec(command) {
  return new Promise((resolve, reject) => {
    const callback = `omkCallback_${Date.now()}_${callbackId++}`;
    const timeout = setTimeout(() => {
      delete window[callback];
      reject(new Error("KernelSU bridge timeout"));
    }, 6000);

    window[callback] = (code, output) => {
      clearTimeout(timeout);
      delete window[callback];
      if (Number(code) === 0) resolve(output);
      else reject(new Error("KernelSU command failed"));
    };

    try {
      window.ksu.exec(command, "{}", callback);
    } catch (error) {
      clearTimeout(timeout);
      delete window[callback];
      reject(error);
    }
  });
}

function daemonCheck(name, script) {
  return `pid=$(cat '${stateDir}/${name}-daemon.pid' 2>/dev/null)
case "$pid" in
  ''|*[!0-9]*) printf '0\n' ;;
  *) if tr '\\000' '\\n' < "/proc/$pid/cmdline" 2>/dev/null | grep -Fxq '${moduleDir}/${script}'; then
       printf '1\n'
     else
       printf '0\n'
     fi ;;
esac`;
}

function renderChip(id, value, yes, no) {
  const chip = document.getElementById(id);
  chip.textContent = value === null ? "—" : value ? yes : no;
  chip.dataset.ok = String(value === true);
}

async function loadStatus() {
  let state = [null, null, null, null];
  refresh.disabled = true;
  actions.forEach(button => { button.disabled = true; });
  try {
    if (typeof window.ksu?.exec !== "function") {
      summary.textContent = "请从 KernelSU 模块列表打开";
      return;
    }

    const output = await exec(`${daemonCheck("keymint", "daemon")}
${daemonCheck("injector", "daemon-injector")}
for file in config.toml injector.toml; do
  if [ -f '${configDir}'/"$file" ]; then printf '1\n'; else printf '0\n'; fi
done`);
    const values = output.trim().split(/\s+/);
    if (values.length !== 4 || values.some(value => !/^[01]$/.test(value))) {
      throw new Error("Unexpected status output");
    }

    state = values.map(value => value === "1");
    const [keymint, injector] = state;
    summary.textContent = keymint && injector ? "两个守护进程均在运行" :
      keymint || injector ? "部分守护进程未运行" : "守护进程未运行";
    actions.forEach(button => {
      const target = button.dataset.restart;
      button.disabled = target === "keymint" ? !keymint :
        target === "injector" ? !injector : !(keymint && injector);
    });
  } catch {
    summary.textContent = "读取状态失败，请刷新重试";
  } finally {
    renderChip("keymint", state[0], "运行中", "未运行");
    renderChip("injector", state[1], "运行中", "未运行");
    renderChip("config", state[2], "已找到", "未找到");
    renderChip("settings", state[3], "已找到", "未找到");
    refresh.disabled = false;
  }
}

refresh.addEventListener("click", loadStatus);
actions.forEach(button => {
  button.addEventListener("click", () => {
    restartTarget = button.dataset.restart;
    confirm.returnValue = "";
    document.querySelector("#confirm-title").textContent = `重启 ${restartLabels[restartTarget]}？`;
    confirm.showModal();
  });
});

confirm.addEventListener("close", async () => {
  if (confirm.returnValue !== "restart" || !Object.hasOwn(restartLabels, restartTarget)) return;
  refresh.disabled = true;
  actions.forEach(button => { button.disabled = true; });
  notice.hidden = true;
  try {
    await exec(`touch '${stateDir}/restart.${restartTarget}'`);
    notice.textContent = "已提交重启请求。";
  } catch {
    notice.textContent = "提交重启请求失败。";
  } finally {
    notice.hidden = false;
    await loadStatus();
  }
});

loadStatus();

const byId = id => document.getElementById(id);
const tabs = [...document.querySelectorAll("[data-page]")];
const levels = ["off", "error", "warn", "info", "debug", "trace"];
const levelFields = [
  { file: "config.toml", select: byId("level-keymint") },
  { file: "injector.toml", select: byId("level-injector") }
];
const saveLevels = byId("save-levels");
const settingsStatus = byId("settings-status");
const logSource = byId("log-source");
const logFilter = byId("log-filter");
const logStatus = byId("log-status");
const logOutput = byId("log-output");
let logLines = [];
let saving = false;

const logLevelAwk = `/^[[:space:]]*\\[/ {
  main = ($0 ~ /^[[:space:]]*\\[main\\][[:space:]]*(#.*)?$/)
}
main && /^[[:space:]]*log_level[[:space:]]*=/ {
  if ($0 !~ /^[[:space:]]*log_level[[:space:]]*=[[:space:]]*"(off|error|warn|warning|info|debug|trace)"[[:space:]]*(#.*)?$/) exit 3
  value = $0
  sub(/^[^"]*"/, "", value)
  sub(/".*$/, "", value)
  if (new != "") sub(/"[^"]+"/, "\\"" new "\\"")
  hits++
}
new != "" { print }
END {
  if (hits != 1) exit 3
  if (new == "") print value
}`;

for (const field of levelFields) {
  field.select.add(new Option("不可用", ""));
  for (const level of levels) field.select.add(new Option(level, level));
  field.select.addEventListener("change", updateSaveButton);
}

function updateSaveButton() {
  saveLevels.disabled = saving || !levelFields.some(field => field.original && field.select.value !== field.original);
}

async function loadLevels() {
  if (saving) return;
  settingsStatus.textContent = "正在读取配置…";
  await Promise.all(levelFields.map(async field => {
    field.select.disabled = true;
    field.original = "";
    field.select.value = "";
    try {
      const output = await exec(`awk '${logLevelAwk}' '${configDir}/${field.file}'`);
      const value = output.trim();
      field.original = value === "warning" ? "warn" : value;
      if (levels.includes(field.original)) {
        field.select.value = field.original;
        field.select.disabled = false;
      }
    } catch {
      field.original = "";
    }
  }));
  settingsStatus.textContent = levelFields.every(field => field.original) ? "" : "部分日志级别无法读取，请检查配置文件。";
  updateSaveButton();
}

async function saveLevel(field, value) {
  const path = `${configDir}/${field.file}`;
  await exec(`set -e
file='${path}'
[ -f "$file" ] && [ ! -L "$file" ]
before=$(sha256sum "$file")
current=$(awk '${logLevelAwk}' "$file")
[ "$current" != warning ] || current=warn
[ "$current" = '${field.original}' ]
temp=$(mktemp "${configDir}/.webui.XXXXXX")
trap 'rm -f "$temp"' EXIT
cp -p "$file" "$temp"
awk -v new='${value}' '${logLevelAwk}' "$file" > "$temp"
restorecon "$temp"
[ "$(sha256sum "$file")" = "$before" ]
mv -f "$temp" "$file"`);
}

saveLevels.addEventListener("click", async () => {
  if (saving) return;
  const changes = levelFields.filter(field => field.original && levels.includes(field.select.value) && field.select.value !== field.original);
  if (!changes.length) return;
  saving = true;
  updateSaveButton();
  levelFields.forEach(field => { field.select.disabled = true; });
  const results = await Promise.allSettled(changes.map(field => saveLevel(field, field.select.value)));
  saving = false;
  await loadLevels();
  const failed = changes.filter((field, index) => results[index].status === "rejected").map(field => field.file);
  const restart = changes.some((field, index) => field.file === "config.toml" && results[index].status === "fulfilled");
  settingsStatus.textContent = [
    failed.length ? `保存失败：${failed.join("、")}。` : "已保存日志级别。",
    restart ? "重启 KeyMint 后生效。" : ""
  ].filter(Boolean).join(" ");
});

function renderLogs() {
  const query = logFilter.value.trim().toLowerCase();
  const lines = logLines.filter(line => line.toLowerCase().includes(query));
  logOutput.textContent = lines.join("\n");
  logStatus.textContent = logLines.length ? `显示 ${lines.length} / ${logLines.length} 行` : "暂无日志";
}

async function loadLogs() {
  const button = byId("load-log");
  if (button.disabled) return;
  const source = logSource.value;
  if (!["keymint", "injector"].includes(source)) return;
  button.disabled = true;
  logSource.disabled = true;
  logOutput.textContent = "";
  logLines = [];
  logStatus.textContent = "正在读取日志…";
  try {
    const output = await exec(`file='${configDir}/logs/${source}.log'; [ -r "$file" ] && tail -n 150 "$file" | tail -c 65536`);
    logLines = output.trimEnd() ? output.trimEnd().split("\n") : [];
    renderLogs();
  } catch {
    logStatus.textContent = "读取日志失败，请从 KernelSU 打开并重试。";
  } finally {
    button.disabled = false;
    logSource.disabled = false;
  }
}

async function loadDevice() {
  try {
    const output = await exec(`getprop ro.build.version.release
getprop ro.product.cpu.abi
sed -n 's/^version=//p' '${moduleDir}/module.prop'`);
    const values = output.trimEnd().split("\n");
    ["device-android", "device-abi", "device-version"].forEach((id, index) => {
      byId(id).textContent = values[index]?.trim() || "—";
    });
  } catch {
    ["device-android", "device-abi", "device-version"].forEach(id => { byId(id).textContent = "—"; });
  }
}

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    const page = tab.dataset.page;
    const wasHidden = byId(`page-${page}`).hidden;
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute("aria-pressed", String(selected));
      byId(`page-${item.dataset.page}`).hidden = !selected;
    }
    if (!wasHidden) return;
    if (page === "settings" && !levelFields.some(field => field.original)) loadLevels();
    if (page === "diagnostics") {
      loadDevice();
      loadLogs();
    }
  });
}

byId("load-log").addEventListener("click", loadLogs);
logSource.addEventListener("change", loadLogs);
logFilter.addEventListener("input", renderLogs);
