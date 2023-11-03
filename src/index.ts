import "dotenv/config";
import http from "http";
import fs from "fs/promises";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import bunyan from "bunyan";
import { fetch } from "@whatwg-node/fetch";
import { Client } from "@notionhq/client";
import {
  BlockObjectResponse,
  PageObjectResponse,
} from "@notionhq/client/build/src/api-endpoints";
import { maxBy, partition, sortBy } from "lodash";

const logger = bunyan.createLogger({ name: "notion-helper" });
const SPLIT_DATE = new Date(2023, 7, 1, 0, 0, 0, 0);
const KB_ID = process.env.KB_ID;

if (!KB_ID) {
  throw new Error('provide knowledge base id');
}

yargs(hideBin(process.argv))
  .command("auth", "Obtain authorization from Notion", {}, () => {
    import("open").then(async ({ default: open }) => {
      const server = http
        .createServer(async (req, res) => {
          if (req.url?.startsWith("/redirect")) {
            try {
              const oauthResponse = await fetch(
                "https://api.notion.com/v1/oauth/token",
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Notion-Version": "2022-06-28",
                    Authorization: `Basic ${Buffer.from(
                      `${process.env.OAUTH_CLIENT_ID}:${process.env.OAUTH_CLIENT_SECRET}`,
                    ).toString("base64")}`,
                  },
                  body: JSON.stringify({
                    grant_type: "authorization_code",
                    code: new URLSearchParams(
                      req.url.replace("/redirect", ""),
                    ).get("code"),
                    redirect_uri: "http://localhost:8888/redirect",
                  }),
                },
              );

              if (oauthResponse.ok) {
                const oauthData = await oauthResponse.json();
                await fs.writeFile(
                  "notion-token.json",
                  JSON.stringify(oauthData, null, 2),
                );
                res
                  .writeHead(200, { "Content-Type": "text/plain" })
                  .end(
                    "Succesfully retrieved OAuth authorization data. You can close this page.",
                  );
                await server.close();
              } else {
                throw new Error(
                  "Failed to retrieve the OAuth authorization data.",
                );
              }
            } catch (error) {
              logger.error(error);
              res
                .writeHead(500, { "Content-Type": "text/plain" })
                .end(
                  typeof error === "object" &&
                    error !== null &&
                    "message" in error
                    ? error.message
                    : "Unknown error occured.",
                );
              await server.close();
            }
          } else {
            res
              .writeHead(404, { "Content-Type": "text/plain" })
              .end("404 Not Found");
            return;
          }
        })
        .listen(8888);
      open(process.env.OAUTH_AUTH_URL);
    });
  })
  .command("read", "Read Knowledge Base structure", {}, async () => {
    const tokenRaw = await fs.readFile("notion-token.json", "utf-8");
    const tokenData = JSON.parse(tokenRaw);
    const { access_token: accessToken } = tokenData;

    const client = new Client({ auth: accessToken });
    const page = await client.pages.retrieve({
      page_id: KB_ID,
    });

    const pageBlocks = await client.blocks.children.list({ block_id: page.id });

    if (pageBlocks.object === "list") {
      const kbDbBlock = pageBlocks.results.find((block) => {
        if ("type" in block) {
          return block.type === "child_database";
        }
      }) as Extract<BlockObjectResponse, { type: "child_database" }>;

      if (kbDbBlock !== undefined) {
        const kbDb = await client.databases.retrieve({
          database_id: kbDbBlock.id,
        });

        let kbDbPages: typeof kbDbPagesPart.results = [];
        let cursor = undefined;
        let kbDbPagesPart = await client.databases.query({
          database_id: kbDb.id,
          start_cursor: cursor,
        });

        do {
          kbDbPages = [...kbDbPages, ...kbDbPagesPart.results];
          cursor = kbDbPagesPart.next_cursor;

          kbDbPagesPart = await client.databases.query({
            database_id: kbDb.id,
            ...(cursor ? { start_cursor: cursor } : {}),
          });
        } while (kbDbPagesPart.has_more);

        const totalArticles = kbDbPages.length;

        const fullKbPages = kbDbPages.filter(
          (page) => "parent" in page,
        ) as PageObjectResponse[];

        const [articlesPast, articlesFuture] = partition(
          fullKbPages,
          (page) => {
            const createdTime = new Date(page.created_time);

            return createdTime.getTime() < SPLIT_DATE.getTime();
          },
        );

        const skillAreaHistogram = articlesFuture.reduce((map, page) => {
          if ("parent" in page) {
            const skillArea = page.properties["Skill/Area"];
            if (
              skillArea?.type === "multi_select" &&
              Array.isArray(skillArea.multi_select)
            ) {
              skillArea.multi_select.forEach((skill) => {
                const currentCount = map.get(skill.name) ?? 0;
                map.set(skill.name, currentCount + 1);
              });
            }
          }

          return map;
        }, new Map<string, number>());

        const authorshipHistogram = articlesFuture.reduce((map, page) => {
          const currentCount = map.get(page.created_by.id) ?? 0;
          map.set(page.created_by.id, currentCount + 1);
          return map;
        }, new Map<string, number>());

        const dateHistogram = articlesFuture.reduce((map, page) => {
          const currentCount =
            map.get(new Date(page.created_time).toLocaleDateString()) ?? 0;

          map.set(
            new Date(page.created_time).toLocaleDateString(),
            currentCount + 1,
          );

          return map;
        }, new Map<string, number>());

        const mostActiveDay = maxBy(
          Array.from(dateHistogram.entries()),
          ([, value]) => value,
        );

        if (mostActiveDay) {
          console.log(
            "Most active day is",
            mostActiveDay[0],
            "with",
            mostActiveDay[1],
            "entries added",
          );
        }

        const allUsers = await client.users.list({ page_size: 500 });
        const authorsData = allUsers.results.reduce((map, user) => {
          if (authorshipHistogram.has(user.id) && user.name) {
            map.set(user.id, {
              name: user.name,
              avatar: user.avatar_url ?? null,
            });
          }

          return map;
        }, new Map<string, { name: string; avatar: string | null }>());

        const mostActiveAuthors = sortBy(
          Array.from(authorshipHistogram.entries()),
          ([, value]) => value,
        ).reverse();

        console.log("Most active authors: ");
        mostActiveAuthors.slice(0, 3).forEach(([userId, count]) => {
          const userName = authorsData.get(userId)?.name ?? "<unknown>";
          console.log(userName, count);
        });

        const mostPopularSkillArea = sortBy(
          Array.from(skillAreaHistogram.entries()),
          ([, value]) => value,
        ).reverse();

        console.log("Number of articles (total):", kbDbPages.length);
        console.log(
          "Most popular skill/areas:",
          mostPopularSkillArea.slice(0, 3),
        );

        console.log(
          "Articles after",
          `${SPLIT_DATE.toLocaleDateString()}:`,
          articlesFuture.length,
        );
        console.log(
          "Articles before",
          `${SPLIT_DATE.toLocaleDateString()}:`,
          articlesPast.length,
        );
        console.log("Delta:", totalArticles - articlesPast.length);
        console.log(
          "Growth by:",
          ((articlesFuture.length / totalArticles) * 100.0).toFixed(2),
          "%",
        );

        const dataJson = {
          performedAt: new Date().toISOString(),
          analysisStartedAt: SPLIT_DATE.toISOString(),
          skillAreaHistogram: Array.from(skillAreaHistogram.entries()),
          authorshipHistogram: Array.from(authorshipHistogram.entries()),
          authorshipData: Array.from(authorsData.entries()),
          pastArticlesLength: articlesPast.length,
          futureArticlesLength: articlesFuture.length,
          dateHistogram: Array.from(dateHistogram.entries()),
        };

        await fs.writeFile("data.json", JSON.stringify(dataJson));
      }
    }
  })
  .parse();
