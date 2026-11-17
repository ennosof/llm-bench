/**
 * Technologie du serveur testé : commandes d'installation, de build et de démarrage proposées par
 * `llm-bench init`, dossiers exclus de la copie et dossiers partageables.
 *
 * Reconnaît Node (npm, yarn, pnpm, bun), Python (uv, Poetry, Pipenv, pip ; FastAPI, Flask, Django),
 * Go, Java (Maven, Gradle ; Spring Boot), .NET, Ruby (Rails, Rack) et PHP (Laravel, Composer).
 * Le port est lu dans la variable `portVar` ($PORT : remplacé par le bench sous Windows, où cmd.exe ne
 * le fait pas). Une commande qui diffère selon le système est un `Cmd` { unix, win } : la config générée
 * contient alors `win ? "…" : "…"`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tr } from "./i18n.js";

export interface Detected<T> {
  value: T;
  sure: boolean;
  why: string;
}

export const sure = <T>(value: T, why: string): Detected<T> => ({ value, sure: true, why });
export const guess = <T>(value: T, why: string): Detected<T> => ({ value, sure: false, why });

/** Commande shell, identique partout ou propre à macOS / Linux et à Windows. */
export type Cmd = string | { unix: string; win: string };
const os = (unix: string, win: string): Cmd => (unix === win ? unix : { unix, win });

export interface Stack {
  /** Identifiant : node, python, go, java, dotnet, ruby, php, unknown. */
  id: string;
  /** Libellé lisible, ex. "Python · FastAPI · uv". */
  label: string;
  install: Detected<Cmd[]>;
  build: Detected<Cmd[]>;
  start: Detected<Cmd>;
  /** Fichier produit par le build, attendu avant le démarrage. */
  readyFile?: Cmd;
  /** Dossiers partageables par lien symbolique avec le projet (option « Partager »). */
  shareDirs: string[];
  /** Dossiers à ne pas copier (dépendances, sorties de build, caches). */
  exclude: string[];
  /** Autres technologies repérées dans le projet (monorepo…). */
  others: string[];
}

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
const readJson = (p: string): any => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const has = (root: string, ...files: string[]) => files.some((f) => existsSync(join(root, f)));

/** Fichiers d'une extension (hors dépendances et sorties de build), au plus `depth` niveaux. */
function sourceFiles(root: string, ext: RegExp, depth = 4): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", ".venv", "venv", "env", "__pycache__", "dist", "build", "target", "bin", "obj", "vendor", "tests", "test"]);
  const walk = (dir: string, d: number) => {
    if (d > depth || out.length > 2000) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (skip.has(e) || e.startsWith(".")) continue;
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, d + 1);
      else if (ext.test(e) && st.size < 500_000) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

// =================================================================================================
// Node
// =================================================================================================

function node(root: string): Stack | null {
  const pkg = readJson(join(root, "package.json"));
  if (!pkg) return null;
  const pm = has(root, "yarn.lock") ? "yarn" : has(root, "pnpm-lock.yaml") ? "pnpm" : has(root, "bun.lockb", "bun.lock") ? "bun" : "npm";
  const run = (script: string) => (pm === "npm" ? `npm run ${script}` : `${pm} ${script}`);
  const install = sure([{ yarn: "yarn install --frozen-lockfile --prefer-offline --non-interactive", pnpm: "pnpm install --frozen-lockfile", bun: "bun install --frozen-lockfile", npm: has(root, "package-lock.json") ? "npm ci" : "npm install" }[pm]!], tr("dépendances : {pm}", { pm }));
  const build = pkg.scripts?.build ? sure([run("build")], tr("build : script \"build\"")) : sure([], tr("pas de script build"));
  let start: Detected<Cmd>;
  let readyFile: string | undefined;
  // Démarrage : point d'entrée compilé (main) s'il y a un build, sinon le script start.
  if (pkg.main && pkg.scripts?.build) {
    start = sure(`node ${pkg.main}`, tr("démarrage : node {main} (champ main)", { main: pkg.main }));
    readyFile = pkg.main;
  } else if (pkg.scripts?.start) start = sure(run("start"), tr("démarrage : script \"start\""));
  else start = guess("node server.js", tr("démarrage : non trouvé"));
  const framework = ["next", "@nestjs/core", "fastify", "express", "hono", "koa"].find((d) => pkg.dependencies?.[d]);
  return { id: "node", label: ["Node", framework, pm].filter(Boolean).join(" · "), install, build, start, readyFile, shareDirs: ["node_modules"], exclude: ["dist", ".next", "coverage"], others: [] };
}

// =================================================================================================
// Python
// =================================================================================================

/** Module Python et variable de l'application, ex. app/main.py: `app = FastAPI()` → { module: "app.main", variable: "app" }. */
function pythonApp(root: string, ctor: RegExp): { module: string; variable: string; file: string } | null {
  for (const f of sourceFiles(root, /\.py$/)) {
    const m = read(f).match(new RegExp(`^(\\w+)\\s*(?::\\s*\\w+\\s*)?=\\s*${ctor.source}\\s*\\(`, "m"));
    if (m) {
      const rel = relative(root, f).replace(/\.py$/, "");
      return { module: rel.split(sep).join(".").replace(/\.__init__$/, ""), variable: m[1], file: relative(root, f) };
    }
  }
  return null;
}

function python(root: string, portVar: string): Stack | null {
  const pyproject = read(join(root, "pyproject.toml"));
  if (!pyproject && !has(root, "requirements.txt", "Pipfile", "setup.py", "manage.py")) return null;
  const P = `$${portVar}`;
  const deps = `${pyproject}\n${read(join(root, "requirements.txt"))}\n${read(join(root, "Pipfile"))}`.toLowerCase();

  // Gestionnaire : uv, Poetry, Pipenv, sinon venv + pip.
  let manager: string, install: Cmd[], shareDirs: string[];
  // Préfixe des outils de l'environnement : `uv run `, `poetry run `… ou le dossier du venv.
  let prefix: Cmd;
  if (has(root, "uv.lock") || /\[tool\.uv\]/.test(pyproject)) {
    manager = "uv"; install = ["uv sync --frozen"]; prefix = "uv run "; shareDirs = [".venv"];
  } else if (has(root, "poetry.lock") || /\[tool\.poetry\]/.test(pyproject)) {
    manager = "Poetry"; install = ["poetry config virtualenvs.in-project true --local", "poetry install --no-root"]; prefix = "poetry run "; shareDirs = [".venv"];
  } else if (has(root, "Pipfile")) {
    manager = "Pipenv"; install = [os("PIPENV_VENV_IN_PROJECT=1 pipenv install --deploy", "set PIPENV_VENV_IN_PROJECT=1&& pipenv install --deploy")]; prefix = "pipenv run "; shareDirs = [".venv"];
  } else {
    manager = "pip";
    const req = has(root, "requirements.txt") ? "-r requirements.txt" : "-e .";
    install = [os("python3 -m venv .venv", "python -m venv .venv"), os(`.venv/bin/pip install ${req}`, `.venv\\Scripts\\pip install ${req}`)];
    prefix = { unix: ".venv/bin/", win: ".venv\\Scripts\\" };
    shareDirs = [".venv"];
  }
  // Commande avec le préfixe de l'environnement, déclinée par système si le préfixe l'est.
  const withPrefix = (rest: string): Cmd => (typeof prefix === "string" ? prefix + rest : os(prefix.unix + rest, prefix.win + rest));
  const py = (rest: string) => withPrefix(`python ${rest}`);

  let framework: string | undefined;
  let start: Detected<Cmd>;
  const fastapi = /fastapi|starlette/.test(deps) ? pythonApp(root, /(?:FastAPI|Starlette)/) : null;
  const flask = !fastapi && /flask/.test(deps) ? pythonApp(root, /Flask/) : null;
  if (fastapi) {
    framework = "FastAPI";
    start = sure(withPrefix(`uvicorn ${fastapi.module}:${fastapi.variable} --host 127.0.0.1 --port ${P}`), tr("démarrage : uvicorn, application {app} dans {file}", { app: fastapi.variable, file: fastapi.file }));
  } else if (flask) {
    framework = "Flask";
    start = sure(withPrefix(`flask --app ${flask.module}:${flask.variable} run --host 127.0.0.1 --port ${P}`), tr("démarrage : flask run, application {app} dans {file}", { app: flask.variable, file: flask.file }));
  } else if (has(root, "manage.py")) {
    framework = "Django";
    start = sure(py(`manage.py runserver 127.0.0.1:${P} --noreload`), tr("démarrage : Django (manage.py runserver)"));
  } else {
    const entry = ["main.py", "app.py", "server.py", "run.py"].find((f) => has(root, f) || has(root, join("app", f)) || has(root, join("src", f)));
    start = entry
      ? guess(py(has(root, entry) ? entry : has(root, join("app", entry)) ? `app/${entry}` : `src/${entry}`), tr("démarrage : {file} (le serveur doit lire le port dans {port})", { file: entry, port: portVar }))
      : guess(py("main.py"), tr("démarrage : non trouvé"));
  }
  return {
    id: "python",
    label: ["Python", framework, manager].filter(Boolean).join(" · "),
    install: sure(install, tr("dépendances : {pm}", { pm: manager })),
    build: sure([], tr("pas de build (Python)")),
    start,
    shareDirs,
    exclude: [".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"],
    others: [],
  };
}

// =================================================================================================
// Go, Java, .NET, Ruby, PHP
// =================================================================================================

function go(root: string): Stack | null {
  if (!has(root, "go.mod")) return null;
  const cmd = existsSync(join(root, "cmd")) ? readdirSync(join(root, "cmd")).find((d) => existsSync(join(root, "cmd", d, "main.go"))) : undefined;
  const pkg = has(root, "main.go") ? "." : cmd ? `./cmd/${cmd}` : ".";
  return {
    id: "go", label: "Go",
    install: sure(["go mod download"], tr("dépendances : {pm}", { pm: "go mod" })),
    build: (pkg !== "." || has(root, "main.go") ? sure : guess)([os(`go build -o .bench-bin/server ${pkg}`, `go build -o .bench-bin/server.exe ${pkg}`)], tr("build : go build {pkg}", { pkg })),
    start: sure(os("./.bench-bin/server", ".bench-bin\\server.exe"), tr("démarrage : binaire compilé (le serveur doit lire le port dans son environnement)")),
    readyFile: os(".bench-bin/server", ".bench-bin/server.exe"),
    shareDirs: [], exclude: [".bench-bin", "vendor"], others: [],
  };
}

function java(root: string, portVar: string): Stack | null {
  const maven = has(root, "pom.xml"), gradle = has(root, "build.gradle", "build.gradle.kts");
  if (!maven && !gradle) return null;
  const P = `$${portVar}`;
  const spring = /spring-boot/.test(read(join(root, "pom.xml")) + read(join(root, "build.gradle")) + read(join(root, "build.gradle.kts")));
  const portArg = spring ? ` --server.port=${P}` : "";
  // Premier jar produit (hors jar « original » / « plain ») ; PowerShell sous Windows, cmd.exe n'ayant pas $(…).
  const jar = (dir: string, skip: string): Cmd => os(
    `java -jar $(ls ${dir}/*.jar | grep -v ${skip} | head -1)${portArg}`,
    `powershell -NoProfile -Command "java -jar (Get-ChildItem ${dir}\\*.jar | Where-Object Name -notmatch '${skip}' | Select-Object -First 1).FullName${portArg.replace(P, "$env:" + portVar)}"`,
  );
  if (maven) {
    const mvn = (args: string) => (has(root, "mvnw") ? os(`./mvnw ${args}`, `mvnw.cmd ${args}`) : `mvn ${args}`);
    return {
      id: "java", label: ["Java", spring && "Spring Boot", "Maven"].filter(Boolean).join(" · "),
      install: sure([mvn("-q -DskipTests dependency:go-offline")], tr("dépendances : {pm}", { pm: "Maven" })),
      build: sure([mvn("-q -DskipTests package")], tr("build : {tool} package", { tool: "Maven" })),
      start: (spring ? sure : guess)(jar("target", "original"), tr("démarrage : jar produit dans {dir}", { dir: "target/" })),
      shareDirs: [], exclude: ["target"], others: [],
    };
  }
  const gradlew = (args: string) => (has(root, "gradlew") ? os(`./gradlew ${args}`, `gradlew.bat ${args}`) : `gradle ${args}`);
  return {
    id: "java", label: ["Java", spring && "Spring Boot", "Gradle"].filter(Boolean).join(" · "),
    install: sure([], tr("dépendances : téléchargées par le build")),
    build: sure([gradlew(`-q ${spring ? "bootJar" : "build"} -x test`)], tr("build : {tool} package", { tool: "Gradle" })),
    start: (spring ? sure : guess)(jar("build/libs", "plain"), tr("démarrage : jar produit dans {dir}", { dir: "build/libs/" })),
    shareDirs: [], exclude: ["build", ".gradle"], others: [],
  };
}

function dotnet(root: string, portVar: string): Stack | null {
  const proj = readdirSync(root).find((f) => /\.(csproj|fsproj)$/.test(f)) ?? (readdirSync(root).some((f) => f.endsWith(".sln")) ? "" : undefined);
  if (proj === undefined) return null;
  const target = proj ? ` --project ${proj}` : "";
  return {
    id: "dotnet", label: ".NET",
    install: sure(["dotnet restore"], tr("dépendances : {pm}", { pm: "NuGet" })),
    build: sure(["dotnet build -c Release --no-restore"], tr("build : dotnet build")),
    start: (proj ? sure : guess)(`dotnet run -c Release --no-build${target} --urls http://127.0.0.1:$${portVar}`, tr("démarrage : dotnet run")),
    shareDirs: [], exclude: ["bin", "obj"], others: [],
  };
}

function ruby(root: string, portVar: string): Stack | null {
  if (!has(root, "Gemfile")) return null;
  const P = `$${portVar}`;
  const rails = has(root, "config/application.rb");
  const start = rails
    ? sure(`bundle exec rails server -b 127.0.0.1 -p ${P}`, tr("démarrage : Rails"))
    : has(root, "config.ru")
      ? sure(`bundle exec rackup -o 127.0.0.1 -p ${P}`, tr("démarrage : Rack (config.ru)"))
      : guess("bundle exec ruby app.rb", tr("démarrage : non trouvé"));
  return {
    id: "ruby", label: ["Ruby", rails && "Rails"].filter(Boolean).join(" · "),
    install: sure(["bundle config set --local path vendor/bundle", "bundle install"], tr("dépendances : {pm}", { pm: "Bundler" })),
    build: sure([], tr("pas de build")),
    start, shareDirs: ["vendor"], exclude: ["vendor", "tmp", "log"], others: [],
  };
}

function php(root: string, portVar: string): Stack | null {
  if (!has(root, "composer.json")) return null;
  const P = `$${portVar}`;
  const laravel = has(root, "artisan");
  return {
    id: "php", label: ["PHP", laravel && "Laravel"].filter(Boolean).join(" · "),
    install: sure(["composer install --no-interaction"], tr("dépendances : {pm}", { pm: "Composer" })),
    build: sure([], tr("pas de build")),
    start: laravel
      ? sure(`php artisan serve --host=127.0.0.1 --port=${P}`, tr("démarrage : Laravel (artisan serve)"))
      : guess(`php -S 127.0.0.1:${P} -t ${has(root, "public") ? "public" : "."}`, tr("démarrage : serveur intégré de PHP")),
    shareDirs: ["vendor"], exclude: ["vendor"], others: [],
  };
}

// =================================================================================================

/** Technologie principale du projet ; `portVar` : variable qui donne le port au serveur. */
export function detectStack(root: string, portVar = "PORT"): Stack {
  const found = [node(root), python(root, portVar), go(root), java(root, portVar), dotnet(root, portVar), ruby(root, portVar), php(root, portVar)].filter(
    (s): s is Stack => Boolean(s),
  );
  // Un package.json sans serveur (outillage front, scripts) ne l'emporte pas sur un serveur d'une autre technologie.
  const nodeIsTooling = found[0]?.id === "node" && !found[0].start.sure && found.length > 1;
  const [main, ...rest] = nodeIsTooling ? [...found.slice(1), found[0]] : found;
  if (!main) {
    return {
      id: "unknown", label: tr("non reconnue"),
      install: guess([], tr("technologie non reconnue : commande d'installation à renseigner")),
      build: guess([], tr("technologie non reconnue : commande de build à renseigner")),
      start: guess("./start.sh", tr("technologie non reconnue : commande de démarrage à renseigner")),
      shareDirs: [], exclude: [], others: [],
    };
  }
  return { ...main, others: rest.map((s) => s.label) };
}
