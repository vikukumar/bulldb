# Contributing to BullDB

Thank you for your interest in contributing to BullDB! As an open-source framework supporting five programming languages, maintaining code style, testing parity, and unified versioning is essential.

---

## Codebase Structure

- `/python/`: Python package module & Pytest suite.
- `/typescript/`: TypeScript NPM package & Jest suite.
- `/golang/`: Go module and testing suite.
- `/rust/`: Rust crate and cargo testing suites.
- `/csharp/`: C# .NET solution and tests.
- `/docs_site/`: Documentation static web application.

---

## Local Development & Testing

Before making a Pull Request, ensure that all tests pass locally for the language package you modified:

### 1. Python
```bash
cd python
pip install -r requirements.txt
python -m pytest
```

### 2. TypeScript
```bash
cd typescript
npm install
npm run build
npm test
```

### 3. Go
```bash
cd golang
go test -v ./...
```

### 4. Rust
```bash
cd rust/bulldb
cargo test
```

### 5. C#
```bash
cd csharp/BullDB.Tests
dotnet test
```

---

## Rules of Contribution

1. **Parity Preservation**: If you add or modify a core database feature, active record lifecycle method, AI provider, or security engine algorithm, you **must** apply the corresponding change across all five languages to maintain parity.
2. **Standardized Encryption Format**: Do not alter the AES-256-GCM cipher layout. It must remain binary compatible across all packages using the `nonce (12b) + tag (16b) + ciphertext` format.
3. **No Hardcoded Static Keys**: Fallback keys must be dynamically generated and cached in memory thread-safely rather than hardcoded in the codebase.
4. **Centralized Versioning**: Never manually edit version strings in files like `Cargo.toml`, `pyproject.toml`, or `package.json`. Always edit [version.json](file:///d:/Projects/BullDB/version.json) at the root and execute `python sync_versions.py` to propagate changes.
5. **CI/CD Compliance**: Make sure changes build correctly under the GitHub Actions workflows defined in `.github/workflows/ci.yml`.

---

## Submitting Pull Requests

1. Fork the repository `https://github.com/vikukumar/bulldb.git` and create your branch from `main`.
2. Commit clear, documented changes.
3. Push to your fork and submit a Pull Request targeting the `main` branch.
