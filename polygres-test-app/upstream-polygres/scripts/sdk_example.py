#!/usr/bin/env python3
"""Equivalent hosted Runtime API query using the cloned Polygres SDK."""

import os

from polygres import Polygres


client = Polygres(
    api_key=os.environ["POLYGRES_API_KEY"],
    runtime_url=os.environ["POLYGRES_RUNTIME_URL"],
)
project = client.project()
page = project.graph.expand(
    {"schema": "public", "table": "users", "id": "user_ada"},
    max_depth=1,
    direction="outgoing",
    relationship_types=["authored"],
    limit=20,
)
for result in page.results:
    print(result.node.id, result.depth, result.edge_path)

