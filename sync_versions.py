import json
import re
import os
import sys

def main():
    # Read version.json
    with open("version.json", "r") as f:
        config = json.load(f)
    base_version = config["version"]
    
    # Check for --build-number
    build_number = None
    if "--build-number" in sys.argv:
        try:
            idx = sys.argv.index("--build-number")
            build_number = sys.argv[idx + 1]
        except (ValueError, IndexError):
            pass

    if build_number:
        version_py = f"{base_version}.post{build_number}"
        version_other = f"{base_version}.{build_number}"
    else:
        version_py = base_version
        version_other = base_version

    print(f"Syncing Python version: {version_py}")
    print(f"Syncing other packages version: {version_other}")

    # Write to GITHUB_ENV if in GitHub Actions
    if "GITHUB_ENV" in os.environ:
        with open(os.environ["GITHUB_ENV"], "a") as env_file:
            env_file.write(f"VERSION_PY={version_py}\n")
            env_file.write(f"VERSION_OTHER={version_other}\n")
            # Set generic VERSION to VERSION_OTHER
            env_file.write(f"VERSION={version_other}\n")

    # 1. Update Python
    # python/pyproject.toml: version = "..."
    pyproject_path = "python/pyproject.toml"
    if os.path.exists(pyproject_path):
        with open(pyproject_path, "r") as f:
            content = f.read()
        content = re.sub(r'version\s*=\s*"[^"]+"', f'version = "{version_py}"', content)
        with open(pyproject_path, "w") as f:
            f.write(content)
        print("Updated python/pyproject.toml")

    # 2. Update TypeScript
    # typescript/package.json: "version": "..."
    package_json_path = "typescript/package.json"
    if os.path.exists(package_json_path):
        with open(package_json_path, "r") as f:
            pkg = json.load(f)
        pkg["version"] = version_other
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
        content = re.sub(r'(?m)^version\s*=\s*"[^"]+"', f'version = "{version_other}"', content)
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
            content = re.sub(r'<Version>[^<]+</Version>', f'<Version>{version_other}</Version>', content)
        else:
            # Insert Version tag under PropertyGroup
            content = re.sub(r'<PropertyGroup>', f'<PropertyGroup>\n    <Version>{version_other}</Version>', content)
        with open(csproj_path, "w") as f:
            f.write(content)
        print("Updated csharp/BullDB/BullDB.csproj")

    # 5. Update Go
    # golang/bulldb/version.go: const Version = "..."
    go_version_path = "golang/bulldb/version.go"
    os.makedirs(os.path.dirname(go_version_path), exist_ok=True)
    with open(go_version_path, "w") as f:
        f.write(f'package bulldb\n\nconst Version = "{version_other}"\n')
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
