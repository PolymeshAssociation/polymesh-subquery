import { findTopLevelComma } from "../src/mappings/util";

test("findTopLevelComma", () => {
  expect(findTopLevelComma("Map<a,b>")).toBe(5);
  expect(findTopLevelComma("Map<Map<(u8,u32),String>,bool>")).toBe(24);
  expect(() => findTopLevelComma("Vec<i8>")).toThrowError();
});
