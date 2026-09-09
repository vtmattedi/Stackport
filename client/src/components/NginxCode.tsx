import { useRef } from "react";
import { cn } from "../lib/utils";
import styles from "./NginxCode.module.scss";

type NginxCodeMode = "editable" | "view";

interface NginxCodeProps {
  value: string;
  mode: NginxCodeMode;
  onChange?: (value: string) => void;
  className?: string;
}

type TokenKind =
  | "plain"
  | "comment"
  | "directive"
  | "variable"
  | "string"
  | "template"
  | "number"
  | "brace"
  | "operator";

interface Token {
  kind: TokenKind;
  text: string;
}

const DIRECTIVES = new Set([
  "access_log",
  "allow",
  "deny",
  "error_log",
  "events",
  "http",
  "include",
  "listen",
  "location",
  "map",
  "proxy_http_version",
  "proxy_pass",
  "proxy_set_header",
  "return",
  "rewrite",
  "root",
  "server",
  "server_name",
  "ssl_certificate",
  "ssl_certificate_key",
  "ssl_ciphers",
  "ssl_prefer_server_ciphers",
  "ssl_protocols",
  "ssl_reject_handshake",
  "upstream",
]);

const TOKEN_RE = /(\{\{[a-zA-Z0-9_]+\}\}|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\$[a-zA-Z_][a-zA-Z0-9_]*|\b\d+(?:\.\d+)?\b|[{}();])/g;

function tokenizeLine(line: string): Token[] {
  const commentStart = line.indexOf("#");
  const source = commentStart >= 0 ? line.slice(0, commentStart) : line;
  const comment = commentStart >= 0 ? line.slice(commentStart) : "";
  const tokens: Token[] = [];
  let lastIndex = 0;

  for (const match of source.matchAll(TOKEN_RE)) {
    const text = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) {
      pushWords(tokens, source.slice(lastIndex, index));
    }
    tokens.push({ kind: classifyToken(text), text });
    lastIndex = index + text.length;
  }

  if (lastIndex < source.length) {
    pushWords(tokens, source.slice(lastIndex));
  }

  if (comment) {
    tokens.push({ kind: "comment", text: comment });
  }

  return tokens.length > 0 ? tokens : [{ kind: "plain", text: "" }];
}

function pushWords(tokens: Token[], text: string): void {
  const parts = text.split(/(\b[a-zA-Z_][a-zA-Z0-9_]*\b)/g);
  for (const part of parts) {
    if (!part) continue;
    tokens.push({
      kind: DIRECTIVES.has(part) ? "directive" : "plain",
      text: part,
    });
  }
}

function classifyToken(text: string): TokenKind {
  if (text.startsWith("{{")) return "template";
  if (text.startsWith("\"") || text.startsWith("'")) return "string";
  if (text.startsWith("$")) return "variable";
  if (/^\d/.test(text)) return "number";
  if (text === "{" || text === "}") return "brace";
  if (text === ";" || text === "(" || text === ")") return "operator";
  return "plain";
}

type TokenKindCamel = `nginxToken${Capitalize<TokenKind>}`;

function kindClass(kind: TokenKind): string {
  const key: TokenKindCamel = `nginxToken${(kind.charAt(0).toUpperCase() + kind.slice(1)) as Capitalize<TokenKind>}`;
  return styles[key] ?? "";
}

function HighlightedCode({ value }: { value: string }) {
  const lines = value.length > 0 ? value.split("\n") : [""];
  return (
    <>
      {lines.map((line, lineIndex) => (
        <span className={styles.nginxCodeLine} key={lineIndex}>
          {tokenizeLine(line).map((token, tokenIndex) => (
            <span className={kindClass(token.kind)} key={tokenIndex}>
              {token.text}
            </span>
          ))}
          {lineIndex < lines.length - 1 ? "\n" : null}
        </span>
      ))}
    </>
  );
}

export default function NginxCode({ value, mode, onChange, className = "" }: NginxCodeProps) {
  const highlightRef = useRef<HTMLPreElement>(null);

  if (mode === "view") {
    return (
      <pre className={cn(styles.nginxCode, styles.nginxCodeView, className)}>
        <HighlightedCode value={value || "(empty file)"} />
      </pre>
    );
  }

  return (
    <div className={cn(styles.nginxCode, styles.nginxCodeEditable, className)}>
      <pre ref={highlightRef} className={styles.nginxCodeHighlight} aria-hidden="true">
        <HighlightedCode value={value} />
      </pre>
      <textarea
        className={styles.nginxCodeTextarea}
        value={value}
        spellCheck={false}
        onChange={(event) => onChange?.(event.target.value)}
        onScroll={(event) => {
          if (!highlightRef.current) return;
          highlightRef.current.scrollTop = event.currentTarget.scrollTop;
          highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
      />
    </div>
  );
}
