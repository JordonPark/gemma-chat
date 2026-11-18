"""Copy unchanged license texts into a model release's upload directory."""

import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("family", choices=("gemma", "drawing"))
parser.add_argument("destination", type=Path)
args = parser.parse_args()

source = Path(__file__).resolve().parents[1] / "licenses" / "modelLicenses.json"
licenses = json.loads(source.read_text(encoding="utf-8"))
documents = (
    {"Gemma-Terms.txt": "gemmaTerms", "Gemma-Prohibited-Use.txt": "gemmaProhibitedUse"}
    if args.family == "gemma"
    else {"CreativeML-OpenRAIL-M.txt": "creativeML"}
)
for name, key in documents.items():
    (args.destination / name).write_text(licenses[key], encoding="utf-8")
