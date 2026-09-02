"""CLI entry point.

    python src/main.py                      # interactive menu
    python src/main.py --mode analyze       # parse story + build character bible
    python src/main.py --mode prompts       # write every prompt file
    python src/main.py --mode test --part 1 # one part, end to end, in the browser
    python src/main.py --mode generate      # all remaining parts
    python src/main.py --mode resume        # retry failed / unfinished parts
    python src/main.py --mode progress      # show checkpoint state
    python src/main.py --mode inspect       # report which Gemini selectors resolve
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent import StoryImageAgent  # noqa: E402
from config import ConfigError, load_config  # noqa: E402
from logger import get_logger, setup_logging  # noqa: E402
from story_parser import StoryParseError  # noqa: E402

MENU = """
Story Image Agent
=================
  1. Analyze story (parse parts + build character bible)
  2. Generate prompts for every part
  3. Test Gemini with one part
  4. Generate all images
  5. Resume failed / incomplete parts
  6. Show progress
  7. Inspect Gemini UI selectors
  0. Exit
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="story-image-agent",
        description="Generate one illustrated image per story part via the Gemini web UI.",
    )
    parser.add_argument("--mode", choices=["analyze", "prompts", "test", "generate",
                                           "resume", "progress", "inspect", "menu"],
                        default="menu", help="what to run (default: interactive menu)")
    parser.add_argument("--part", type=int, action="append",
                        help="part number to process; repeatable (e.g. --part 1 --part 4)")
    parser.add_argument("--limit", type=int,
                        help="maximum number of parts to process in this run")
    parser.add_argument("--start", type=int, help="start from this part number")
    parser.add_argument("--force", action="store_true",
                        help="re-generate parts even if the checkpoint says they are done")
    parser.add_argument("--rebuild-bible", action="store_true",
                        help="overwrite existing character descriptions from the story")
    parser.add_argument("--same-chat", action="store_true",
                        help="keep one Gemini conversation instead of a new chat per part")
    parser.add_argument("--headless", action="store_true",
                        help="run the browser headless (not recommended: sign-in is manual)")
    parser.add_argument("--config", type=Path, help="path to config.json")
    parser.add_argument("--story", type=Path, help="path to the story file (overrides config)")
    parser.add_argument("--probe", action="store_true",
                        help="inspect mode: also send one real prompt so the hooks that "
                             "only exist after an answer can be checked")
    parser.add_argument("--reset", action="store_true",
                        help="clear the checkpoint before running")
    return parser


def make_agent(args: argparse.Namespace) -> StoryImageAgent:
    config = load_config(args.config)
    if args.story:
        config.override("paths.story_file", str(args.story))
    if args.headless:
        config.override("browser.headless", True)
    config.ensure_directories()
    setup_logging(
        logs_dir=config.path("logs_dir"),
        file_name=str(config.get("logging.file_name", "agent.log")),
        level=str(config.get("logging.level", "INFO")),
        console_level=str(config.get("logging.console_level", "INFO")),
    )
    agent = StoryImageAgent(config)
    if args.reset:
        agent.checkpoint.reset()
        get_logger().warning("Checkpoint cleared.")
    return agent


def run_async(coro):
    if sys.platform.startswith("win"):
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    return asyncio.run(coro)


def do_analyze(agent: StoryImageAgent, rebuild: bool = False) -> None:
    agent.load(rebuild_bible=rebuild)
    print(agent.analyze())


def do_prompts(agent: StoryImageAgent) -> None:
    paths = agent.generate_prompts()
    print(f"\n{len(paths)} prompt file(s) written to {agent.config.path('prompts_dir')}")
    if paths:
        print("\n--- preview of the first prompt -------------------------------")
        print(paths[0].read_text(encoding="utf-8")[:1200])
        print("---------------------------------------------------------------")


def do_test(agent: StoryImageAgent, part: int) -> int:
    outcome = run_async(agent.run(indices=[part], force=True))
    print()
    print(outcome.format())
    metadata = agent.config.path("metadata_dir") / f"part_{part:03d}.json"
    image_dir = agent.config.path("images_dir")
    matches = sorted(image_dir.glob(f"part_{part:03d}.*"))
    if matches:
        image = matches[0]
        print(f"\nImage : {image}  ({image.stat().st_size / 1024:.1f} KB)")
        print(f"Prompt: {agent.config.path('prompts_dir') / f'part_{part:03d}.txt'}")
        print(f"Meta  : {metadata}")
        return 0
    print("\nNo image was produced. Check output/logs/agent.log and "
          "output/logs/diagnostics/ for a screenshot of what the page looked like.")
    return 1


def do_generate(agent: StoryImageAgent, args: argparse.Namespace, only_failed: bool = False) -> int:
    outcome = run_async(agent.run(
        indices=args.part,
        limit=args.limit,
        start_at=args.start,
        only_failed=only_failed,
        force=args.force,
        fresh_chat=not args.same_chat,
    ))
    print()
    print(outcome.format())
    print()
    print(agent.progress_report())
    return 1 if outcome.failed and not outcome.generated else 0


def interactive(agent: StoryImageAgent, args: argparse.Namespace) -> int:
    while True:
        print(MENU)
        try:
            choice = input("Choose an option: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if choice in ("0", "q", "exit"):
            return 0
        if choice == "1":
            do_analyze(agent, rebuild=args.rebuild_bible)
        elif choice == "2":
            do_prompts(agent)
        elif choice == "3":
            raw = input("Part number to test [1]: ").strip() or "1"
            if raw.isdigit():
                do_test(agent, int(raw))
            else:
                print("Please enter a number.")
        elif choice == "4":
            do_generate(agent, args)
        elif choice == "5":
            do_generate(agent, args, only_failed=True)
        elif choice == "6":
            print(agent.progress_report())
        elif choice == "7":
            answer = input("Send one real prompt to also check the answer state? [y/N]: ")
            print(run_async(agent.inspect_ui(probe=answer.strip().lower().startswith("y"))))
        else:
            print("Unknown option.")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        agent = make_agent(args)
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2

    try:
        if args.mode == "analyze":
            do_analyze(agent, rebuild=args.rebuild_bible)
            return 0
        if args.mode == "prompts":
            do_prompts(agent)
            return 0
        if args.mode == "test":
            parts = args.part or [1]
            return do_test(agent, parts[0])
        if args.mode == "generate":
            return do_generate(agent, args)
        if args.mode == "resume":
            return do_generate(agent, args, only_failed=True)
        if args.mode == "progress":
            print(agent.progress_report())
            return 0
        if args.mode == "inspect":
            print(run_async(agent.inspect_ui(probe=args.probe)))
            return 0
        return interactive(agent, args)
    except StoryParseError as exc:
        print(f"Story problem: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\nInterrupted. Progress is saved — run --mode resume to continue.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
