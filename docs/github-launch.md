# GitHub Launch Copy

## Repo Description

Open-source corpus research platform for grounded, cited answers over large text datasets, with AlphaBook as the current reference app.

## README Headline

Alpha Research

## README Subtitle

Grounded research infrastructure for large text corpora.

## Short Announcement Blurb

We’re open sourcing Alpha Research, the shared platform behind AlphaBook.

It provides retrieval, runtime analysis, and cited answer synthesis for large corpora, with a neutral document API, adapter-driven ingest, and implementation scaffolding for new datasets.

This repo ships:

- AlphaBook for books
- a minimal fixture adapter that proves the platform is not book-only

The goal is straightforward: keep the product layer implementation-specific while sharing the core research stack underneath.

## Longer Launch Blurb

Alpha Research is now open source.

This repository contains the shared architecture behind AlphaBook and the extensibility surface for future implementations.

- AlphaBook, a book-focused research system
- fixture corpus tooling for a minimal non-book example

Under the hood, the repo uses the same adapter-driven platform for corpus ingest, retrieval, runtime workspace analysis, and cited synthesis. The repo includes a neutral document API, a reusable adapter layer, a local validation path for non-book corpora, and Linux-first scaffolding for future implementations.

If you want to adapt it to another dataset, start with the adapter and implementation docs, then use the fixture adapter and Gutenberg path as reference points.
