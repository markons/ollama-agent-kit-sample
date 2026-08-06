# create_workflow.py
# Run this to generate workflow.md in the current directory

content = """# Ollama Windows Environment Control - Complete Workflow

## Overview
This document documents the complete process of setting up Ollama with tool calling to control Windows 11 from an AI application.

---

## Table of Contents
1. [Initial Setup](#initial-setup)
2. [Model Selection](#model-selection)
3. [Error Resolution](#error-resolution)
4. [Final Working Script](#final-working-script)
5. [Key Concepts](#key-concepts)
6. [Alternative Models](#alternative-models)
7. [Safety Guidelines](#safety-guidelines)

---

## Initial Setup

### Install Ollama Application
1. Download from [ollama.com](https://ollama.com)
2. Run `OllamaSetup.exe` on Windows 11
3. Verify installation: `ollama --version`

### Install Python Library
```bash
pip install ollama