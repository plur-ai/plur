---
name: plur-memory
description: Save something to PLUR memory, or search, correct and remove what is saved, when the user asks PLUR to remember, recall or forget something.
---

# PLUR Memory

PLUR keeps memory notes, called engrams, as plain YAML files in `~/.plur/` on the user's computer.

## When the user asks to remember something

Call `plur_learn` with one clear statement a reader could act on later. Report what was saved.

## When the user asks what is remembered

Call `plur_recall` with the topic, and answer from the results. Say so when nothing matches.

## When a note is wrong or no longer true

Call `plur_forget` with the engram ID, after the user confirms which note to remove. To replace a note, save the corrected version with `plur_learn` and retire the old one.

## When the user says whether a note helped

Call `plur_feedback` with `positive` or `negative`. This changes how the note ranks in later searches.

## When a tool answers with a question about the folder

Memory has not been decided for this folder, so nothing was saved or returned. Show the question to the user and run only the answer they choose.

## Checking the store

`plur_status` reports where notes are stored and how many there are. `plur_admin` with `{ "action": "help" }` lists less common operations.
