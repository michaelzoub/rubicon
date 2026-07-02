#!/usr/bin/env python3
"""Reset fake data, derive authorship edges, build pgGraph, and export UI data."""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
THRESHOLD = float(os.environ.get("MATCH_THRESHOLD", "0.64"))

USERS = [
    ("user_ada", "ada_lovelace"),
    ("user_grace", "grace.hopper"),
    ("user_michael", "michael-zoub"),
    ("user_theo", "theo_codes"),
]

ARTICLES = [
    ("article_analytical", "Notes on the Analytical Engine", "Ada Lovelace"),
    ("article_poetical", "A Poetical Science", "ada-lovelace"),
    ("article_compilers", "Compilers and Clear Thinking", "Grace M. Hopper"),
    ("article_graphs", "Graph Thinking in Postgres", "Michael Zoub"),
    ("article_interfaces", "Interfaces That Explain Themselves", "Theo Codes"),
    ("article_noise", "A Field Guide to Mushrooms", "Robin Forest"),
]

HONORIFICS = {"dr", "mr", "mrs", "ms", "prof"}


def tokens(value: str) -> list[str]:
    parts = re.findall(r"[a-z0-9]+", value.lower())
    return [part for part in parts if part not in HONORIFICS and len(part) > 1]


def compact(value: str) -> str:
    return "".join(tokens(value))


def ngrams(value: str, width: int = 3) -> Counter[str]:
    padded = f"  {compact(value)}  "
    return Counter(padded[i : i + width] for i in range(len(padded) - width + 1))


def cosine(left: Counter[str], right: Counter[str]) -> float:
    numerator = sum(count * right.get(key, 0) for key, count in left.items())
    left_norm = math.sqrt(sum(count * count for count in left.values()))
    right_norm = math.sqrt(sum(count * count for count in right.values()))
    return numerator / (left_norm * right_norm) if left_norm and right_norm else 0.0


def similarity(username: str, author: str) -> float:
    """A deterministic local stand-in for an embedding similarity score."""
    left, right = set(tokens(username)), set(tokens(author))
    token_overlap = len(left & right) / len(left | right) if left | right else 0.0
    sequence = SequenceMatcher(None, compact(username), compact(author)).ratio()
    char_cosine = cosine(ngrams(username), ngrams(author))
    return round(0.20 * token_overlap + 0.35 * sequence + 0.45 * char_cosine, 4)


def psql(sql: str, *, tuples_only: bool = False) -> str:
    command = ["docker", "compose", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1"]
    if tuples_only:
        command += ["-A", "-t"]
    command += ["-U", "postgres", "-d", "graph", "-f", "-"]
    result = subprocess.run(command, cwd=ROOT, input=sql, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result.stdout.strip()


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def main() -> None:
    candidates = []
    edges = []
    for user_id, username in USERS:
        for article_id, _, author in ARTICLES:
            score = similarity(username, author)
            candidate = {
                "userId": user_id,
                "username": username,
                "articleId": article_id,
                "author": author,
                "score": score,
                "accepted": score >= THRESHOLD,
            }
            candidates.append(candidate)
            if candidate["accepted"]:
                edges.append(candidate)

    user_values = ",\n".join(f"({sql_literal(uid)}, {sql_literal(name)})" for uid, name in USERS)
    article_values = ",\n".join(
        f"({sql_literal(aid)}, {sql_literal(title)}, {sql_literal(author)})"
        for aid, title, author in ARTICLES
    )
    edge_values = ",\n".join(
        f"({sql_literal(edge['userId'])}, {sql_literal(edge['articleId'])}, {edge['score']})"
        for edge in edges
    )

    payload = {
        "threshold": THRESHOLD,
        "users": [{"id": uid, "username": username} for uid, username in USERS],
        "articles": [
            {"id": aid, "title": title, "author": author} for aid, title, author in ARTICLES
        ],
        "edges": edges,
        "candidates": sorted(candidates, key=lambda item: item["score"], reverse=True),
        "traversals": {},
    }
    output_path = ROOT / "public" / "data.json"

    if "--score-only" in sys.argv:
        output_path.write_text(json.dumps(payload, indent=2) + "\n")
        print_results(edges, len(candidates), output_path, database_built=False)
        return

    setup_sql = f"""
    CREATE EXTENSION IF NOT EXISTS graph;
    DROP TABLE IF EXISTS authorship_edges, articles, users CASCADE;
    CREATE TABLE users (id text PRIMARY KEY, username text NOT NULL UNIQUE);
    CREATE TABLE articles (id text PRIMARY KEY, title text NOT NULL, author text NOT NULL);
    CREATE TABLE authorship_edges (
      user_id text NOT NULL REFERENCES users(id),
      article_id text NOT NULL REFERENCES articles(id),
      similarity double precision NOT NULL CHECK (similarity BETWEEN 0 AND 1),
      PRIMARY KEY (user_id, article_id)
    );
    INSERT INTO users VALUES {user_values};
    INSERT INTO articles VALUES {article_values};
    {f'INSERT INTO authorship_edges VALUES {edge_values};' if edge_values else ''}

    SELECT graph.reset();
    SELECT graph.add_table('users'::regclass, 'id', ARRAY['username']);
    SELECT graph.add_table('articles'::regclass, 'id', ARRAY['title', 'author']);
    SELECT graph.add_edge(
      'authorship_edges'::regclass,
      'user_id',
      'articles'::regclass,
      'article_id',
      'authored',
      bidirectional := false,
      weight_column := 'similarity'
    );
    SELECT * FROM graph.build();
    """
    psql(setup_sql)

    traversals = {}
    for user_id, _ in USERS:
        output = psql(
            f"""SELECT node_id, node_table_name, depth, edge_path
                 FROM graph.traverse('users'::regclass, {sql_literal(user_id)}, 1,
                   direction := 'out', hydrate := false)
                 WHERE depth = 1 ORDER BY node_id;""",
            tuples_only=True,
        )
        traversals[user_id] = [line for line in output.splitlines() if line]

    payload["traversals"] = traversals
    output_path.write_text(json.dumps(payload, indent=2) + "\n")

    print_results(edges, len(candidates), output_path, database_built=True)


def print_results(
    edges: list[dict], candidate_count: int, output_path: Path, *, database_built: bool
) -> None:

    print(f"Threshold: {THRESHOLD:.2f}")
    print(f"Materialized {len(edges)} one-way authorship edges from {candidate_count} candidates:")
    for edge in edges:
        print(f"  {edge['username']} -> {edge['author']} ({edge['score']:.4f})")
    print(f"Wrote {output_path.relative_to(ROOT)}")
    print("pgGraph database built and traversed" if database_built else "Scoring only; pgGraph was not started")


if __name__ == "__main__":
    main()
