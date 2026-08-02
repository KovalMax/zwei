#!/bin/sh

NAME_PREFIX="$1"

docker compose -p "$NAME_PREFIX" up -d --force-recreate
