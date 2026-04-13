#!/usr/bin/env python3
"""CLI script to upload a file to the solonbot /api/upload endpoint."""
import argparse
import base64
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


def build_multipart_body(
    file_data: bytes,
    filename: str,
    content_type: str,
) -> tuple[bytes, str]:
    """Build a multipart/form-data request body for the given file data.

    Returns a tuple of (body_bytes, boundary_string).
    """
    boundary = uuid.uuid4().hex

    parts: list[bytes] = []

    # File field.
    parts.append(
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f"Content-Type: {content_type}\r\n"
            f"\r\n"
        ).encode("utf-8")
        + file_data
        + b"\r\n"
    )

    # Filename field.
    parts.append(
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="filename"\r\n'
            f"\r\n"
            f"{filename}\r\n"
        ).encode("utf-8")
    )

    body = b"".join(parts) + f"--{boundary}--\r\n".encode("utf-8")
    return body, boundary


def upload_file(
    url: str,
    filepath: str | None,
    password: str | None,
) -> None:
    """Upload a file to the given URL and print the server's response.

    If filepath is None, reads from stdin as stdin.txt.
    Raises urllib.error.URLError or urllib.error.HTTPError on network/HTTP errors.
    Raises OSError if the file cannot be read.
    """
    # Parse the URL to extract credentials if present (e.g., https://user:pass@host/path).
    parsed = urllib.parse.urlparse(url)
    effective_password = password

    if parsed.password is not None:
        effective_password = parsed.password
        # Rebuild the URL without credentials.
        clean_netloc = parsed.hostname or ""
        if parsed.port is not None:
            clean_netloc += f":{parsed.port}"
        url = urllib.parse.urlunparse((
            parsed.scheme,
            clean_netloc,
            parsed.path,
            parsed.params,
            parsed.query,
            parsed.fragment,
        ))

    if filepath is not None:
        filename = os.path.basename(filepath)
        guessed_type, _ = mimetypes.guess_type(filepath)
        content_type = guessed_type if guessed_type is not None else "application/octet-stream"
        with open(filepath, "rb") as file_handle:
            file_data = file_handle.read()
    else:
        filename = "stdin.txt"
        content_type = "text/plain"
        file_data = sys.stdin.buffer.read()

    body, boundary = build_multipart_body(file_data, filename, content_type)

    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )

    if effective_password is not None:
        # HTTP Basic Auth with a fixed username, as the server only checks the password.
        credentials = base64.b64encode(f"user:{effective_password}".encode("utf-8")).decode("ascii")
        request.add_header("Authorization", f"Basic {credentials}")

    with urllib.request.urlopen(request) as response:
        print(response.read().decode("utf-8"))


def parse_args() -> argparse.Namespace:
    """Parse and return command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Upload a file to the solonbot /api/upload endpoint."
    )
    parser.add_argument("url", help="Full URL of the upload endpoint.")
    parser.add_argument(
        "filepath",
        nargs="?",
        default=None,
        help="Path to the local file to upload. If omitted, reads from stdin.",
    )
    parser.add_argument(
        "--password",
        default=None,
        help="Password for HTTP Basic Auth (username is ignored).",
    )
    return parser.parse_args()


def main() -> None:
    """Entry point: parse arguments and upload the file."""
    args = parse_args()

    try:
        upload_file(args.url, args.filepath, args.password)
    except urllib.error.HTTPError as error:
        print(f"HTTP error {error.code}: {error.read().decode('utf-8', errors='replace')}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as error:
        print(f"Network error: {error.reason}", file=sys.stderr)
        sys.exit(1)
    except OSError as error:
        print(f"Error reading file: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
