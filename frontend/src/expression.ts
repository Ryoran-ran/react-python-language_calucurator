export type Expression =
  | { type: "word"; value: string }
  | { type: "scalar"; value: number }
  | { op: string; left: Expression; right: Expression };

function tokenize(source: string): string[] {
  const token =
    /\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\[(?:[^\]\\]|\\.)+\]|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[^\s()[\]+＋*/×÷−－-]+|[()+＋*/×÷−－-])/gy;
  const tokens: string[] = [];
  let position = 0;
  while (position < source.length) {
    token.lastIndex = position;
    const match = token.exec(source);
    if (!match) {
      if (source.slice(position).trim() === "") break;
      throw new Error("式に使えない文字、または閉じていない括弧があります。");
    }
    tokens.push(match[1]);
    position = token.lastIndex;
  }
  return tokens;
}

export function parseExpression(source: string): Expression {
  if (source.length > 4000) throw new Error("式は4000文字以内にしてください。");
  const tokens = tokenize(source);
  let index = 0,
    count = 0;
  function factor(depth: number): Expression {
    if (++count > 127 || depth > 16) throw new Error("式が複雑すぎます。");
    const token = tokens[index++];
    if (!token) throw new Error("単語または数値が必要です。");
    if (token === "(") {
      const result = sum(depth + 1);
      if (tokens[index++] !== ")")
        throw new Error("括弧が閉じられていません。");
      return result;
    }
    if (["-", "−", "－"].includes(token))
      return {
        op: "multiply",
        left: { type: "scalar", value: -1 },
        right: factor(depth + 1),
      };
    if ([")", "+", "＋", "*", "×", "/", "÷"].includes(token))
      throw new Error("演算子の前後に単語が必要です。");
    if (/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/i.test(token))
      return { type: "scalar", value: Number(token) };
    return {
      type: "word",
      value: token.startsWith('"')
        ? JSON.parse(token)
        : token.startsWith("[")
          ? token.slice(1, -1).replace(/\\(.)/g, "$1")
          : token.replace(/^'|'$/g, ""),
    };
  }
  function product(depth: number): Expression {
    let result = factor(depth);
    while (["*", "×", "/", "÷"].includes(tokens[index])) {
      const operator = tokens[index++];
      result = {
        op: ["*", "×"].includes(operator) ? "multiply" : "divide",
        left: result,
        right: factor(depth + 1),
      };
    }
    return result;
  }
  function sum(depth: number): Expression {
    let result = product(depth);
    while (["+", "＋", "-", "−", "－"].includes(tokens[index])) {
      const operator = tokens[index++];
      result = {
        op: ["+", "＋"].includes(operator) ? "add" : "subtract",
        left: result,
        right: product(depth + 1),
      };
    }
    return result;
  }
  const result = sum(0);
  if (index !== tokens.length)
    throw new Error("演算子または括弧を確認してください。");
  const infer = (node: Expression): "word" | "scalar" => {
    if ("type" in node) return node.type;
    const left = infer(node.left),
      right = infer(node.right);
    if (
      ["add", "subtract"].includes(node.op) &&
      left === "word" &&
      right === "word"
    )
      return "word";
    if (node.op === "multiply" && left !== right) return "word";
    if (node.op === "divide" && left === "word" && right === "scalar")
      return "word";
    throw new Error(
      "加減算はベクトル同士、乗除算はスカラーと組み合わせてください。",
    );
  };
  if (infer(result) !== "word")
    throw new Error("ベクトルを含む式を入力してください。");
  return result;
}
