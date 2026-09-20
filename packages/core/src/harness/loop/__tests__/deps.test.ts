import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readNodeDeps, readRustDeps, readPythonDeps, readMavenDeps, readDotNetDeps } from "../context.js";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { rm } from "fs/promises";

describe("Dependency Parsing", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "owncoder-deps-test-"));
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("readNodeDeps", () => {
    it("should parse package.json with dependencies and devDependencies", async () => {
      const pkgJson = JSON.stringify({
        dependencies: {
          express: "^4.18.0",
          lodash: "^4.17.21",
        },
        devDependencies: {
          vitest: "^1.0.0",
          eslint: "^8.0.0",
        },
      }, null, 2);

      await writeFile(join(tempDir, "package.json"), pkgJson);

      const result = await readNodeDeps(tempDir);

      expect(result).toContain("### npm (package.json)");
      expect(result).toContain("#### dependencies");
      expect(result).toContain("#### devDependencies");
      expect(result).toContain("express: ^4.18.0");
      expect(result).toContain("lodash: ^4.17.21");
      expect(result).toContain("vitest: ^1.0.0");
      expect(result).toContain("eslint: ^8.0.0");
    });

    it("should return empty string for empty package.json", async () => {
      const pkgJson = JSON.stringify({
        name: "test",
      }, null, 2);

      await writeFile(join(tempDir, "package.json"), pkgJson);

      const result = await readNodeDeps(tempDir);

      expect(result).toBe("");
    });

    it("should return empty string when package.json missing", async () => {
      const result = await readNodeDeps(tempDir);
      expect(result).toBe("");
    });
  });

  describe("readRustDeps", () => {
    it("should parse Cargo.toml with regular dependencies", async () => {
      const cargoToml = `
[package]
name = "test"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = "1.0"
tokio = { version = "1.0", features = ["full"] }

[dev-dependencies]
criterion = "0.5"

[build-dependencies]
cc = "1.0"
`.trim();

      await writeFile(join(tempDir, "Cargo.toml"), cargoToml);

      const result = await readRustDeps(tempDir);

      expect(result).toContain("### cargo (Cargo.toml)");
      expect(result).toContain("#### dependencies");
      expect(result).toContain("#### dev-dependencies");
      expect(result).toContain("#### build-dependencies");
      expect(result).toContain("serde: 1.0");
      expect(result).toContain("tokio: 1.0");
      expect(result).toContain("criterion: 0.5");
      expect(result).toContain("cc: 1.0");
    });

    it("should parse Cargo.toml with workspace dependencies", async () => {
      const cargoToml = `
[package]
name = "test"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { workspace = true }
tokio = "1.0"

[workspace.dependencies]
serde = "1.0.193"
serde_json = "1.0"

[workspace]
`.trim();

      await writeFile(join(tempDir, "Cargo.toml"), cargoToml);

      const result = await readRustDeps(tempDir);

      expect(result).toContain("serde: 1.0.193");
      expect(result).toContain("tokio: 1.0");
    });

    it("should return empty string when Cargo.toml missing", async () => {
      const result = await readRustDeps(tempDir);
      expect(result).toBe("");
    });
  });

  describe("readPythonDeps", () => {
    it("should parse pyproject.toml with PEP 621", async () => {
      const pyproject = `
[project]
name = "test"
version = "0.1.0"
dependencies = [
  "requests>=2.28.0",
  "pydantic>=2.0",
]

[project.optional-dependencies]
dev = [
  "pytest>=7.0",
  "black>=23.0",
]
`.trim();

      await writeFile(join(tempDir, "pyproject.toml"), pyproject);

      const result = await readPythonDeps(tempDir);

      expect(result).toContain("### python");
      expect(result).toContain("#### pyproject (PEP 621)");
      expect(result).toContain("dependencies:");
      expect(result).toContain("requests>=2.28.0");
      expect(result).toContain("pydantic>=2.0");
    });

    it("should parse pyproject.toml with Poetry dependencies", async () => {
      const pyproject = `
[tool.poetry]
name = "test"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.8"
requests = "^2.28.0"
pydantic = "^2.0"

[tool.poetry.group.dev.dependencies]
pytest = "^7.0"
`.trim();

      await writeFile(join(tempDir, "pyproject.toml"), pyproject);

      const result = await readPythonDeps(tempDir);

      expect(result).toContain("#### pyproject (poetry)");
      expect(result).toContain("requests: ^2.28.0");
      expect(result).toContain("pydantic: ^2.0");
      expect(result).toContain("pytest: ^7.0");
    });
  });

  describe("readMavenDeps", () => {
    it("should parse pom.xml with single dependency", async () => {
      const pomXml = `
<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>test</artifactId>
  <version>1.0.0</version>
  
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>3.0.0</version>
    </dependency>
  </dependencies>
</project>
`.trim();

      await writeFile(join(tempDir, "pom.xml"), pomXml);

      const result = await readMavenDeps(tempDir);

      expect(result).toContain("### maven (pom.xml)");
      expect(result).toContain("#### dependencies");
      expect(result).toContain("org.springframework.boot:spring-boot-starter-web: 3.0.0");
    });

    it("should parse pom.xml with multiple dependencies", async () => {
      const pomXml = `
<?xml version="1.0" encoding="UTF-8"?>
<project>
  <dependencies>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <version>4.13.2</version>
    </dependency>
    <dependency>
      <groupId>org.mockito</groupId>
      <artifactId>mockito-core</artifactId>
    </dependency>
  </dependencies>
</project>
`.trim();

      await writeFile(join(tempDir, "pom.xml"), pomXml);

      const result = await readMavenDeps(tempDir);

      expect(result).toContain("junit:junit: 4.13.2");
      expect(result).toContain("org.mockito:mockito-core: (managed)");
    });

    it("should return empty string when pom.xml missing", async () => {
      const result = await readMavenDeps(tempDir);
      expect(result).toBe("");
    });
  });

  describe("readDotNetDeps", () => {
    it("should parse csproj with PackageReference", async () => {
      const csproj = `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
    <PackageReference Include="Serilog" Version="3.0.0" />
  </ItemGroup>
</Project>
`.trim();

      await writeFile(join(tempDir, "test.csproj"), csproj);

      const result = await readDotNetDeps(tempDir);

      expect(result).toContain("### nuget (test.csproj)");
      expect(result).toContain("#### PackageReference");
      expect(result).toContain("Newtonsoft.Json: 13.0.3");
      expect(result).toContain("Serilog: 3.0.0");
    });

    it("should return empty string when no .csproj found", async () => {
      const result = await readDotNetDeps(tempDir);
      expect(result).toBe("");
    });
  });
});
