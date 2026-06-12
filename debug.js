// const fetch = require("node-fetch");

// async function test() {
//   const response = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//       // "Authorization": "Beare",
//     },
//     body: JSON.stringify({
//       model: "gemini-1.5-flash",
//       messages: [{ role: "user", content: "say hello" }],
//       max_tokens: 100
//     })
//   });

//   console.log("Status:", response.status);
//   const text = await response.text();
//   console.log("Raw response:", text);
// }

// test();