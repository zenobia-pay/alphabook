# GitHub Launch Copy

## Repo Description

Open-source corpus research platform for grounded, cited answers over large text datasets, with AlphaBook and AlphaJustice as reference apps.

## README Headline

Alpha Research

## README Subtitle

Grounded research infrastructure for large text corpora, with `AlphaBook` and `AlphaJustice` as reference implementations.

## Short Announcement Blurb

We’re open sourcing Alpha Research, the shared platform behind AlphaBook and AlphaJustice.

It provides retrieval, runtime analysis, and cited answer synthesis for large corpora, with a neutral document API, adapter-driven ingest, and separate implementation layers for different datasets.

This repo ships two concrete implementations today:

- AlphaBook for books
- AlphaJustice for U.S. Supreme Court cases

The goal is straightforward: keep the product layer implementation-specific while sharing the core research stack underneath.

## Longer Launch Blurb

Alpha Research is now open source.

This repository contains the shared architecture behind two separate implementations:

- AlphaBook, a book-focused research system
- AlphaJustice, a Supreme Court case research system

Under the hood, both run on the same adapter-driven platform for corpus ingest, retrieval, runtime workspace analysis, and cited synthesis. The repo includes a neutral document API, a reusable adapter layer, a local validation path for non-book corpora, and separate deployment wrappers for each implementation.

If you want to adapt it to another dataset, start with the adapter and implementation docs, then use the existing book and Supreme Court implementations as reference points.
