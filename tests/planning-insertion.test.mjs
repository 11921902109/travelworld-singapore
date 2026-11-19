import assert from "node:assert/strict";
import { test } from "node:test";
import { planningBoardInsertionIndex } from "../lib/travel/planning-insertion.ts";
test("timeline hotel, airport and scene anchors keep their actual insertion order on the day board",()=>{
 const stops=[{id:"airport",placeId:"airport-1"},{id:"hotel-start",placeId:"hotel-1"},{id:"scene-a",placeId:"place-a"},{id:"text-block"},{id:"scene-b",placeId:"place-b"},{id:"hotel-end",placeId:"hotel-1"}];const ids=["candidate-a","candidate-b"],candidates=[{id:"candidate-a",placeId:"place-a"},{id:"candidate-b",placeId:"place-b"}];
 const at=(nodeId,placement)=>planningBoardInsertionIndex(stops,ids,candidates,{nodeId,placement});
 assert.equal(at("airport","after"),0);assert.equal(at("hotel-start","after"),0);assert.equal(at("scene-a","before"),0);assert.equal(at("scene-a","after"),1);assert.equal(at("text-block","after"),1);assert.equal(at("hotel-end","before"),2);assert.equal(at("missing","before"),undefined);
});
