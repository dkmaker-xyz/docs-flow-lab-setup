import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { checkManifests, type Tech } from "../src/tech/check.js";
import { findManifests, parseDockerfile, parsePackageJson, parsePom, readManifests } from "../src/tech/manifests.js";
import { exactVersion, npmSpec, techRange, within } from "../src/tech/ranges.js";

const temp = mkdtempSync(join(tmpdir(), "idc365-tech-"));
after(() => rmSync(temp, { recursive: true, force: true }));
let n = 0;
function tree(files: Record<string, string>): string {
  const root = join(temp, String(n++));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

const POM = `<project>
  <!-- <dependency><groupId>commented</groupId><artifactId>out</artifactId></dependency> -->
  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.5.7</version></parent>
  <groupId>x</groupId><artifactId>app</artifactId><version>1.0.0</version>
  <properties><guava.version>33.4.8-jre</guava.version></properties>
  <dependencyManagement><dependencies>
    <dependency><groupId>org.junit</groupId><artifactId>junit-bom</artifactId><version>5.13.4</version><type>pom</type><scope>import</scope></dependency>
    <dependency><groupId>not</groupId><artifactId>imported</artifactId><version>1.0</version></dependency>
  </dependencies></dependencyManagement>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
    <dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>\${guava.version}</version></dependency>
    <dependency><groupId>a</groupId><artifactId>b</artifactId><version>\${missing}</version></dependency>
  </dependencies>
  <build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.5.4</version></plugin></plugins></build>
</project>`;

describe("ranges", () => {
  test("TECH ranges", () => {
    assert.deepEqual(techRange("19.*"), { min: [19, 0, 0], max: [20, 0, 0] });
    assert.deepEqual(techRange("19"), { min: [19, 0, 0], max: [20, 0, 0] });
    assert.deepEqual(techRange("19.2.*"), { min: [19, 2, 0], max: [19, 3, 0] });
    assert.deepEqual(techRange("19.2.1"), { min: [19, 2, 1], max: [19, 2, 2] });
    assert.equal(techRange("^19"), undefined);
  });
  test("npm specs and containment", () => {
    const r19 = techRange("19.*")!;
    const r192 = techRange("19.2.*")!;
    assert.ok(within(npmSpec("^19.2.0")!, r19));
    assert.ok(!within(npmSpec("^19.2.0")!, r192), "^ allows 19.3");
    assert.ok(within(npmSpec("~19.2.0")!, r192));
    assert.ok(within(npmSpec("19.2.9")!, r192));
    assert.ok(within(npmSpec("19.x")!, r19));
    assert.ok(!within(npmSpec("^18.3.1")!, r19));
    assert.ok(within(npmSpec("7.1.0-dev.20261102.1")!, techRange("7.*")!), "prerelease counts as its version");
    assert.deepEqual(npmSpec("^0.2.3"), { min: [0, 2, 3], max: [0, 3, 0] });
    for (const bad of [">=1.0.0", "1.x || 2.x", "*", "latest", "github:x/y"]) assert.equal(npmSpec(bad), undefined, bad);
  });
  test("exact Maven versions and Docker tags", () => {
    assert.ok(within(exactVersion("33.4.8-jre")!, techRange("33.*")!));
    assert.ok(within(exactVersion("24.11-alpine")!, techRange("24.*")!));
    assert.ok(!within(exactVersion("24")!, techRange("24.11.*")!), "a major-only tag covers the whole line");
    assert.equal(exactVersion("alpine"), undefined);
  });
});

describe("manifests", () => {
  test("finds package.json, pom.xml and Dockerfile* and skips build output", () => {
    const root = tree({ "apps/web/package.json": "{}", "apps/web/node_modules/x/package.json": "{}", "apps/api/pom.xml": "<project/>", "apps/api/target/pom.xml": "", "Dockerfile": "", "apps/web/Dockerfile.prod": "", "docs/readme.md": "" });
    assert.deepEqual(findManifests(root), ["Dockerfile", "apps/api/pom.xml", "apps/web/Dockerfile.prod", "apps/web/package.json"]);
  });
  test("package.json: dependencies and devDependencies, workspace packages skipped, lockfile versions used", () => {
    const root = tree({
      "package-lock.json": JSON.stringify({ packages: { "": {}, "node_modules/react": { version: "19.2.9" } } }),
      "apps/web/package.json": JSON.stringify({ dependencies: { react: "^19.2.0", ui: "workspace:*" }, devDependencies: { typescript: "7.0.2" } }),
    });
    const m = parsePackageJson(root, "apps/web/package.json");
    assert.deepEqual(m.dependencies.map((d) => `${d.name} ${d.spec} ${d.resolved} ${d.role}`), ["react ^19.2.0 19.2.9 dependency", "typescript 7.0.2 7.0.2 dev"]);
  });
  test("pom.xml: parent, imported BOM, direct dependencies, properties; comments, plugins and plain management entries ignored", () => {
    const m = parsePom(tree({ "pom.xml": POM }), "pom.xml");
    assert.deepEqual(
      m.dependencies.map((d) => `${d.role} ${d.name} ${d.spec ?? "-"}${d.problem ? ` (${d.problem})` : ""}`),
      [
        "parent org.springframework.boot:spring-boot-starter-parent 3.5.7",
        "bom org.junit:junit-bom 5.13.4",
        "dependency org.springframework.boot:spring-boot-starter-web -",
        "dependency com.google.guava:guava 33.4.8-jre",
        "dependency a:b ${missing} (unresolved property ${missing})",
      ],
    );
  });
  test("Dockerfile: FROM images with tags; stage aliases, scratch and ARG defaults handled", () => {
    const root = tree({
      Dockerfile: "ARG NODE=24.11\nFROM --platform=linux/amd64 docker.io/library/node:${NODE}-alpine AS build\nFROM build AS test\nFROM scratch AS empty\nFROM nginx:1.29-alpine\nCOPY --from=build /a /b\nFROM ghcr.io/acme/tool:2.1.0\nFROM python\nFROM redis:alpine\nFROM busybox@sha256:abc\n",
    });
    const m = parseDockerfile(root, "Dockerfile");
    assert.deepEqual(
      m.dependencies.map((d) => `${d.name} ${d.spec ?? "-"}${d.problem ? ` (${d.problem})` : ""}`),
      ["node 24.11-alpine", "nginx 1.29-alpine", "ghcr.io/acme/tool 2.1.0", "python - (no tag (means latest))", "redis alpine (tag `alpine` is not a version)", "busybox - (pinned by digest only, without a version tag)"],
    );
  });
});

const tech = (id: string, ecosystem: string, packages: { name: string; version?: string }[], extra: Partial<Tech> = {}): Tech => ({ id, file: `docs/techstack/${id}.md`, title: id, state: "accepted", ecosystem, packages, exemptions: [], ...extra });
const TECHS: Tech[] = [
  tech("TECH-0001", "npm", [{ name: "react", version: "19.*" }, { name: "react-dom", version: "19.*" }]),
  tech("TECH-0002", "npm", [{ name: "typescript", version: "7.*" }]),
  tech("TECH-0003", "maven", [{ name: "org.springframework.boot:spring-boot-starter-parent" }, { name: "org.springframework.boot:spring-boot-starter-web" }], { version: "3.5.*" }),
  tech("TECH-0004", "maven", [{ name: "com.google.guava:guava", version: "33.*" }]),
  tech("TECH-0005", "docker", [{ name: "node", version: "24.*" }]),
  tech("TECH-0006", "docker", [{ name: "nginx", version: "1.*" }]),
  tech("TECH-0007", "npm", [{ name: "lodash", version: "4.*" }], { state: "deprecated" }),
];

const APP = {
  "apps/web/package.json": JSON.stringify({ dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" }, devDependencies: { typescript: "7.0.2" } }),
  "apps/web/Dockerfile": "FROM node:24.11-alpine AS build\nFROM nginx:1.29-alpine\n",
  "apps/integration2/pom.xml": `<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.5.7</version></parent>
  <dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
  <dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>33.4.8-jre</version></dependency></dependencies></project>`,
};
const check = (files: Record<string, string>, techs = TECHS, extra = {}) => checkManifests(readManifests(tree(files)), techs, { ref: "main", cooldownDays: 3, ...extra });
const rules = (r: { findings: { rule: string; package: string }[] }) => r.findings.map((f) => `${f.rule} ${f.package}`);

describe("tech check", () => {
  test("passes when every direct dependency is listed and in range", async () => {
    const r = await check(APP);
    assert.deepEqual(r.findings, []);
    assert.equal(r.dependencies, 8);
  });
  test("fails on an unlisted package, an out-of-range major and an unlisted base image", async () => {
    const r = await check({
      ...APP,
      "apps/web/package.json": JSON.stringify({ dependencies: { react: "^18.3.1", "react-dom": "^19.2.0", lodash: "^4.17.21" } }),
      "apps/web/Dockerfile": "FROM node:24.11-alpine AS build\nFROM python:3.13-slim\n",
    });
    assert.deepEqual(rules(r).sort(), ["tech.range react", "tech.unlisted lodash", "tech.unlisted python"].sort());
    assert.match(r.findings.find((f) => f.rule === "tech.range")!.message, /react@\^18\.3\.1` is outside the approved range \(TECH-0001 allows 19\.\*\)/);
    assert.match(r.findings.find((f) => f.package === "lodash")!.fix, /tech create --version vX\.Y\.Z --ecosystem npm --package lodash@<range>/);
  });
  test("a managed Maven dependency needs an approved parent or BOM", async () => {
    const noParent = `<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>`;
    assert.deepEqual(rules(await check({ "pom.xml": noParent })), ["tech.bom org.springframework.boot:spring-boot-starter-web"]);
    const oldParent = APP["apps/integration2/pom.xml"].replace("3.5.7", "3.4.2");
    assert.deepEqual(rules(await check({ "pom.xml": oldParent })).sort(), ["tech.bom org.springframework.boot:spring-boot-starter-web", "tech.range org.springframework.boot:spring-boot-starter-parent"]);
  });
  test("unpinned images, uncheckable specs and unresolved properties are findings", async () => {
    const r = await check({ Dockerfile: "FROM node\n", "package.json": JSON.stringify({ dependencies: { react: ">=19.0.0" } }), "pom.xml": `<project><dependencies><dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>\${v}</version></dependency></dependencies></project>` });
    assert.deepEqual(rules(r).sort(), ["tech.spec react", "tech.unpinned com.google.guava:guava", "tech.unpinned node"]);
  });
  test("a TECH that is not accepted does not approve", async () => {
    assert.deepEqual(rules(await check({ "package.json": JSON.stringify({ dependencies: { lodash: "4.17.21" } }) })), ["tech.unlisted lodash"]);
  });
});

describe("cooldown", () => {
  const today = new Date("2026-11-02T12:00:00Z");
  const dates = (map: Record<string, string>) => async (_e: string, name: string, version: string) => (map[`${name}@${version}`] ? new Date(map[`${name}@${version}`]!) : undefined);
  const files = { "package.json": JSON.stringify({ devDependencies: { typescript: "7.1.0-dev.20261102.1" } }) };

  test("a version younger than the cooldown fails", async () => {
    const r = await check(files, TECHS, { today, releaseDate: dates({ "typescript@7.1.0-dev.20261102.1": "2026-11-02T08:16:29Z" }) });
    assert.deepEqual(rules(r), ["tech.cooldown typescript"]);
    assert.match(r.findings[0]!.fix, /--cooldown-exemption typescript@7\.1\.0-dev\.20261102\.1=CVE-YYYY-NNNN:2026-11-05/);
  });
  test("an old enough version passes; a missing date is a note, not a failure", async () => {
    const ok = await check(files, TECHS, { today, releaseDate: dates({ "typescript@7.1.0-dev.20261102.1": "2026-10-20T00:00:00Z" }) });
    assert.deepEqual(ok.findings, []);
    const unknown = await check(files, TECHS, { today, releaseDate: dates({}) });
    assert.deepEqual(unknown.findings, []);
    assert.match(unknown.notes[0]!.message, /release date of 7\.1\.0-dev\.20261102\.1 not found/);
  });
  test("an exemption naming the version and a CVE applies until its date; an expired one does not", async () => {
    const exempt = (until: string) => TECHS.map((t) => (t.id === "TECH-0002" ? { ...t, exemptions: [{ package: "typescript", version: "7.1.0-dev.20261102.1", cve: "CVE-2026-12345", until }] } : t));
    const young = dates({ "typescript@7.1.0-dev.20261102.1": "2026-11-02T08:16:29Z" });
    const valid = await check(files, exempt("2026-11-05"), { today, releaseDate: young });
    assert.deepEqual(valid.findings, []);
    assert.match(valid.notes[0]!.message, /exempted by TECH-0002 for CVE-2026-12345 until 2026-11-05/);
    const expired = await check(files, exempt("2026-11-01"), { today, releaseDate: young });
    assert.deepEqual(rules(expired), ["tech.cooldown typescript"]);
    assert.match(expired.notes[0]!.message, /expired on 2026-11-01/);
  });
  test("Docker images are not cooldown-checked", async () => {
    let asked = 0;
    const r = await check({ Dockerfile: "FROM node:24.11-alpine\n" }, TECHS, { today, releaseDate: async () => (asked++, new Date(today)) });
    assert.deepEqual(r.findings, []);
    assert.equal(asked, 0);
  });
});
