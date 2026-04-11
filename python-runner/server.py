"""HTTP server that accepts Python code and executes it via uv run."""

import base64
import http.server
import json
import os
import pwd
import shutil
import signal
import stat as stat_module
import subprocess
import sys
import tempfile
import tomllib
from http import HTTPStatus


PORT = 3003
TIMEOUT_SECONDS = 30
SIGKILL_GRACE_SECONDS = 5
CONFIG_PATH = "/root/config/config.toml"
MAX_FILE_TRANSFER_BYTES = 25 * 1024 * 1024  # 25 MB


def load_config() -> str:
    """Read config.toml and return the password.

    Raises SystemExit if the password is missing, since the server must not
    start without authentication configured.
    """
    with open(CONFIG_PATH, "rb") as config_file:
        config = tomllib.load(config_file)

    password = config.get("password")
    if not password:
        print("[python-runner] Fatal: 'password' is missing from config.toml", file=sys.stderr)
        raise SystemExit(1)

    return password


PASSWORD = load_config()


def check_auth(auth_header: str | None) -> bool:
    """Return True if the Authorization header contains the correct Basic Auth password."""
    if not auth_header:
        return False
    if not auth_header.startswith("Basic "):
        return False
    try:
        decoded = base64.b64decode(auth_header[len("Basic "):]).decode()
    except Exception:
        return False
    # The format is ":password" (empty username).
    _, _, provided_password = decoded.partition(":")
    return provided_password == PASSWORD


def get_pythonrunner_ids() -> tuple[int, int]:
    """Return the uid and gid of the pythonrunner system user."""
    entry = pwd.getpwnam("pythonrunner")
    return entry.pw_uid, entry.pw_gid


def build_script_content(code: str, dependencies: list[str]) -> str:
    """Prepend a PEP 723 inline script metadata block if dependencies are given."""
    if not dependencies:
        return code
    dep_list = ", ".join(f'"{dep}"' for dep in dependencies)
    metadata = f"# /// script\n# dependencies = [{dep_list}]\n# ///\n"
    return metadata + code


def materialize_input_files(files: list[dict[str, str]], uid: int, gid: int) -> None:
    """Delete and recreate /tmp/input/, then write each file into it."""
    input_dir = "/tmp/input"
    shutil.rmtree(input_dir, ignore_errors=True)
    os.makedirs(input_dir)
    # Allow the pythonrunner user to enter and read the directory.
    os.chown(input_dir, uid, gid)
    os.chmod(input_dir, 0o755)

    for file_entry in files:
        filename = file_entry["filename"]
        data = base64.b64decode(file_entry["data"])
        file_path = os.path.join(input_dir, filename)
        with open(file_path, "wb") as output_file:
            output_file.write(data)
        os.chown(file_path, uid, gid)
        os.chmod(file_path, 0o644)


def prepare_output_dir(uid: int, gid: int) -> None:
    """Delete and recreate /tmp/output/ so the pythonrunner user can write to it."""
    output_dir = "/tmp/output"
    shutil.rmtree(output_dir, ignore_errors=True)
    os.makedirs(output_dir)
    os.chown(output_dir, uid, gid)
    # Allow the pythonrunner user to read and write the directory.
    os.chmod(output_dir, 0o755)


def collect_output_files() -> tuple[list[dict[str, str]], str]:
    """Scan /tmp/output/ for regular files and base64-encode them.

    Returns a tuple of (files list, warning message). The warning is non-empty
    only when the total size exceeds the limit, in which case files is empty.
    """
    output_dir = "/tmp/output"
    try:
        entries = os.listdir(output_dir)
    except OSError:
        return [], ""

    # Open with O_NOFOLLOW so the kernel refuses to follow symlinks atomically.
    # This prevents a TOCTOU race where a background process left behind by the
    # script could swap a regular file for a symlink between a check and the open.
    # Without this, the root process would follow the symlink and read arbitrary files.
    safe_files: list[tuple[str, int]] = []
    for name in entries:
        file_path = os.path.join(output_dir, name)
        try:
            fd = os.open(file_path, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError:
            continue
        stat = os.fstat(fd)
        if not stat_module.S_ISREG(stat.st_mode):
            os.close(fd)
            continue
        safe_files.append((file_path, fd))

    total_size = sum(os.fstat(fd).st_size for _, fd in safe_files)
    if total_size > MAX_FILE_TRANSFER_BYTES:
        for _, fd in safe_files:
            os.close(fd)
        warning = f"Output files ({total_size} bytes) exceed the 25 MB limit and were not returned."
        print(f"[python-runner] {warning}", file=sys.stderr)
        return [], warning

    result = []
    for file_path, fd in safe_files:
        with os.fdopen(fd, "rb") as file_handle:
            encoded = base64.b64encode(file_handle.read()).decode()
        result.append({"filename": os.path.basename(file_path), "data": encoded})

    return result, ""


def run_script(
    code: str,
    dependencies: list[str],
    files: list[dict[str, str]],
) -> tuple[str, list[dict[str, str]]]:
    """Write code to a temp file, execute it via uv run, and return output and output files."""
    try:
        uid, gid = get_pythonrunner_ids()
    except KeyError:
        return "Failed to spawn process: pythonrunner user not found.", []

    script_content = build_script_content(code, dependencies)

    with tempfile.NamedTemporaryFile(
        mode="w",
        suffix=".py",
        dir="/tmp",
        delete=False,
        prefix="python-runner-",
    ) as script_file:
        script_file.write(script_content)
        script_path = script_file.name

    # Make the temp file readable by the pythonrunner user.
    os.chmod(script_path, 0o644)

    materialize_input_files(files, uid, gid)
    prepare_output_dir(uid, gid)

    print(
        f"[python-runner] Spawning uv run {script_path} as uid={uid} gid={gid}",
        file=sys.stderr,
    )

    env = {
        "PATH": os.environ.get("PATH", ""),
        "UV_CACHE_DIR": "/tmp/uv-cache",
        "UV_PYTHON_INSTALL_DIR": "/opt/uv/python",
        "SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt",
        "REQUESTS_CA_BUNDLE": "/etc/ssl/certs/ca-certificates.crt",
    }

    try:
        try:
            process = subprocess.Popen(
                ["uv", "run", script_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd="/tmp",
                env=env,
                user=uid,
                group=gid,
                extra_groups=[],
            )
        except (OSError, subprocess.SubprocessError) as error:
            print(f"[python-runner] Failed to spawn process: {error}", file=sys.stderr)
            return f"Failed to spawn process: {error}", []

        timed_out = False
        try:
            stdout_bytes, stderr_bytes = process.communicate(timeout=TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            timed_out = True
            process.send_signal(signal.SIGTERM)
            try:
                stdout_bytes, stderr_bytes = process.communicate(timeout=SIGKILL_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout_bytes, stderr_bytes = process.communicate()

        stdout = stdout_bytes.decode(errors="replace")
        stderr = stderr_bytes.decode(errors="replace")
        exit_code = process.returncode

        output = stdout
        if stderr:
            output += ("\n" if output else "") + f"stderr:\n{stderr}"

        if timed_out:
            timeout_message = f"Process timed out after {TIMEOUT_SECONDS} seconds."
            output += ("\n" if output else "") + timeout_message
            print(
                f"[python-runner] Script timed out, partial output length={len(output)}",
                file=sys.stderr,
            )
            return output if output else timeout_message, []

        output_files, size_warning = collect_output_files()
        if size_warning:
            output += ("\n" if output else "") + size_warning

        if exit_code != 0:
            exit_message = f"Exit code: {exit_code}."
            output += ("\n" if output else "") + exit_message
            print(
                f"[python-runner] Script failed with exit code {exit_code}, output length={len(output)}",
                file=sys.stderr,
            )
            return output if output else f"Script exited with code {exit_code} and produced no output.", output_files

        if not output and not output_files:
            print("[python-runner] Script succeeded with no output", file=sys.stderr)
            return "Script produced no output.", []

        print(
            f"[python-runner] Script succeeded, output length={len(output)}, output files={len(output_files)}",
            file=sys.stderr,
        )
        return output, output_files

    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass
        shutil.rmtree("/tmp/input", ignore_errors=True)
        shutil.rmtree("/tmp/output", ignore_errors=True)


class RequestHandler(http.server.BaseHTTPRequestHandler):
    """HTTP request handler for the python-runner server."""

    def log_message(self, format: str, *args: object) -> None:
        """Override to use the project log prefix."""
        print(f"[python-runner] {format % args}", file=sys.stderr)

    def do_POST(self) -> None:
        """Handle POST /run requests."""
        if not check_auth(self.headers.get("Authorization")):
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return

        if self.path != "/run":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid Content-Length"})
            return
        body = self.rfile.read(content_length)

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON"})
            return

        if not isinstance(payload, dict) or "code" not in payload:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing required field: code"})
            return

        code = payload["code"]
        if not isinstance(code, str):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "field 'code' must be a string"})
            return

        raw_dependencies = payload.get("dependencies") or []
        if not isinstance(raw_dependencies, list):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "field 'dependencies' must be a list"})
            return
        if not all(isinstance(dep, str) for dep in raw_dependencies):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "every element of 'dependencies' must be a string"})
            return
        dependencies: list[str] = raw_dependencies

        raw_files = payload.get("files") or []
        if not isinstance(raw_files, list):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "field 'files' must be a list"})
            return

        files: list[dict[str, str]] = []
        total_decoded_size = 0
        for index, file_entry in enumerate(raw_files):
            if not isinstance(file_entry, dict):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": f"files[{index}] must be an object"})
                return
            if "filename" not in file_entry or "data" not in file_entry:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": f"files[{index}] must have 'filename' and 'data' fields"},
                )
                return
            filename = file_entry["filename"]
            if not isinstance(filename, str) or not isinstance(file_entry["data"], str):
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": f"files[{index}]: 'filename' and 'data' must be strings"},
                )
                return
            # Reject filenames with path separators or that reduce to empty after basename.
            safe_name = os.path.basename(filename)
            if not safe_name:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": f"files[{index}]: unsafe or empty filename"},
                )
                return
            try:
                decoded_data = base64.b64decode(file_entry["data"])
            except Exception:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": f"files[{index}]: 'data' is not valid base64"},
                )
                return
            total_decoded_size += len(decoded_data)
            if total_decoded_size > MAX_FILE_TRANSFER_BYTES:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "total size of input files exceeds the 25 MB limit"},
                )
                return
            files.append({"filename": safe_name, "data": file_entry["data"]})

        print(
            f"[python-runner] POST /run: code length={len(code)}, dependencies={len(dependencies)}, input files={len(files)}",
            file=sys.stderr,
        )

        output, output_files = run_script(code, dependencies, files)
        self._send_json(HTTPStatus.OK, {"output": output, "files": output_files})

    def do_GET(self) -> None:
        """Return 404 for all GET requests."""
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_PUT(self) -> None:
        """Return 404 for all PUT requests."""
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_DELETE(self) -> None:
        """Return 404 for all DELETE requests."""
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_PATCH(self) -> None:
        """Return 404 for all PATCH requests."""
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_OPTIONS(self) -> None:
        """Return 404 for all OPTIONS requests."""
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_HEAD(self) -> None:
        """Return 404 for all HEAD requests."""
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_TRACE(self) -> None:
        """Return 404 for all TRACE requests."""
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_CONNECT(self) -> None:
        """Return 404 for all CONNECT requests."""
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def _send_json(self, status: HTTPStatus, data: dict[str, object]) -> None:
        """Send a JSON response with the given status code and data."""
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    """Start the HTTP server on PORT."""
    server = http.server.ThreadingHTTPServer(("", PORT), RequestHandler)
    print(f"[python-runner] Listening on port {PORT}", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
