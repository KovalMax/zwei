#!/bin/sh
set -eu

path=${1:-}
case "$path" in
  /*) ;;
  *) echo 'DEPLOY_PATH must be an absolute path' >&2; exit 1 ;;
esac
case "$path" in
  *[!A-Za-z0-9_./-]*|*//*|*/./*|*/../*|*/.|*/..|*/)
    echo 'DEPLOY_PATH contains unsupported path syntax' >&2
    exit 1
    ;;
esac
