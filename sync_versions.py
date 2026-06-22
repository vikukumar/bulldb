import json
import re
import os

def main():
    # Read version.json
    with open("version.json", "r") as f:
        config = json.load(f)
    version = config["version"]
    print(f"Syncing version: {version}")

    # 1. Update Python
    # python/pyproject.toml: version = "..."
    pyproject_path = "python/pyproject.toml"
    if os.path.exists(pyproject_path):
        with open(pyproject_path, "r") as f:
            content = f.read()
        content = re.sub(r'version\s*=\s*"[^"]+"', f'version = "{version}"', content)
        with open(pyproject_path, "w") as f:
            f.write(content)
        print("Updated python/pyproject.toml")

    # 2. Update TypeScript
    # typescript/package.json: "version": "..."
    package_json_path = "typescript/package.json"
    if os.path.exists(package_json_path):
        with open(package_json_path, "r") as f:
            pkg = json.load(f)
        pkg["version"] = version
        with open(package_json_path, "w") as f:
            json.dump(pkg, f, indent=2)
            f.write("\n")
        print("Updated typescript/package.json")

    # 3. Update Rust
    # rust/bulldb/Cargo.toml: version = "..."
    cargo_path = "rust/bulldb/Cargo.toml"
    if os.path.exists(cargo_path):
        with open(cargo_path, "r") as f:
            content = f.read()
        content = re.sub(r'(?m)^version\s*=\s*"[^"]+"', f'version = "{version}"', content)
        with open(cargo_path, "w") as f:
            f.write(content)
        print("Updated rust/bulldb/Cargo.toml")

    # 4. Update C#
    # csharp/BullDB/BullDB.csproj: <Version>...</Version>
    csproj_path = "csharp/BullDB/BullDB.csproj"
    if os.path.exists(csproj_path):
        with open(csproj_path, "r") as f:
            content = f.read()
        if "<Version>" in content:
            content = re.sub(r'<Version>[^<]+</Version>', f'<Version>{version}</Version>', content)
        else:
            # Insert Version tag under PropertyGroup
            content = re.sub(r'<PropertyGroup>', f'<PropertyGroup>\n    <Version>{version}</Version>', content)
        with open(csproj_path, "w") as f:
            f.write(content)
        print("Updated csharp/BullDB/BullDB.csproj")

    # 5. Update Go
    # golang/bulldb/version.go: const Version = "..."
    go_version_path = "golang/bulldb/version.go"
    os.makedirs(os.path.dirname(go_version_path), exist_ok=True)
    with open(go_version_path, "w") as f:
        f.write(f'package bulldb\n\nconst Version = "{version}"\n')
    print("Updated golang/bulldb/version.go")

    # Copy LICENSE.md to all subdirectories to ensure it is always present during builds
    import shutil
    subprojects = [
        "typescript",
        "python",
        "rust/bulldb",
        "csharp/BullDB",
        "golang"
    ]
    for sp in subprojects:
        if os.path.exists(sp):
            shutil.copy("LICENSE.md", sp)
            print(f"Copied LICENSE.md to {sp}/")

if __name__ == "__main__":
    main()
