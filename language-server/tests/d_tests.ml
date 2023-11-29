open Common
open Dm
open Types
open Base

[@@@warning "-27"]

let trdeps doc s1 =
  (* This closure should be an API used in Schedule used by ExecutionManager *)
  let rec trclose f s =
    let s' = Stateid.Set.fold (fun x acc -> Stateid.Set.union (f x) acc) s s in
    if Stateid.Set.equal s s' then s
    else trclose f s' in
  trclose (Scheduler.dependents (Document.schedule doc)) (Stateid.Set.singleton s1.id)

let %test_unit "document: invalidate top" =
  let dm, _ = init_test_doc ~text:"Definition x := 3. Lemma foo : x = 3. Proof. reflexivity. Qed." in
  let doc = DocumentManager.Internal.document dm in
  let unchanged, invalid, doc = Document.validate_document doc in
  [%test_eq: sentence_id list] [] (Stateid.Set.elements invalid);
  let s1,(s2,(s3,(s4,(s5,())))) = d_sentences doc (P(P(P(P(P(O)))))) in
  [%test_eq: sentence_id option] (Some s5.id) unchanged;
  let doc = Document.apply_text_edits doc [Document.range_of_id doc s1.id,"Definition x := 4."] in
  let unchanged, invalid, doc = Document.validate_document doc in
  let r1,(r2,(r3,(r4,(r5,())))) = d_sentences doc (P(P(P(P(P(O)))))) in
  [%test_eq: sentence_id list] [s1.id] (Stateid.Set.elements invalid);
  [%test_eq: sentence_id option] None unchanged;
  [%test_eq: sentence_id] s2.id r2.id;
  [%test_eq: sentence_id] s3.id r3.id;
  [%test_eq: sentence_id] s4.id r4.id;
  [%test_eq: sentence_id] s5.id r5.id;
  let deps = trdeps doc s1 in
  [%test_pred: sentence_id] (fun x -> Stateid.Set.mem x deps) r2.id;
  [%test_pred: sentence_id] (fun x -> Stateid.Set.mem x deps) r3.id;
  [%test_pred: sentence_id] (fun x -> Stateid.Set.mem x deps) r4.id;
  [%test_pred: sentence_id] (fun x -> Stateid.Set.mem x deps) r5.id;
  ()

let %test_unit "document: invalidate proof" =
  let dm, _ = init_test_doc ~text:"Definition x := 3. Lemma foo : x = 3. Proof. reflexivity. Qed." in
  let doc = DocumentManager.Internal.document dm in
  let unchanged, invalid, doc = Document.validate_document doc in
  [%test_eq: sentence_id list] [] (Stateid.Set.elements invalid);
  let s1,(s2,(s3,(s4,(s5,())))) = d_sentences doc (P(P(P(P(P(O)))))) in
  [%test_eq: sentence_id option] (Some s5.id) unchanged;
  let doc = Document.apply_text_edits doc [Document.range_of_id doc s3.id,"idtac."] in
  let unchanged, invalid, doc = Document.validate_document doc in
  let r1,(r2,(r3,(r4,(r5,())))) = d_sentences doc (P(P(P(P(P(O)))))) in
  [%test_eq: sentence_id list] [s3.id] (Stateid.Set.elements invalid);
  [%test_eq: sentence_id option] (Some s2.id) unchanged;
  [%test_eq: sentence_id] s1.id r1.id;
  [%test_eq: sentence_id] s2.id r2.id;
  [%test_eq: sentence_id] s4.id r4.id;
  [%test_eq: sentence_id] s5.id r5.id;
  let deps = trdeps doc s3 in
  [%test_pred: sentence_id] (fun x -> not (Stateid.Set.mem x deps)) r1.id;
  [%test_pred: sentence_id] (fun x -> not (Stateid.Set.mem x deps)) r2.id;
  [%test_pred: sentence_id] (fun x -> not (Stateid.Set.mem x deps)) r3.id;
  [%test_pred: sentence_id] (fun x -> not (Stateid.Set.mem x deps)) r5.id;
  ()


let %test_unit "document: invalidate proof 2" =
  let dm, _ = init_test_doc ~text:"Definition x := 3. Lemma foo : x = 3. Proof. reflexivity. Qed." in
  let doc = DocumentManager.Internal.document dm in
  let unchanged, invalid, doc = Document.validate_document doc in
  [%test_eq: sentence_id list] [] (Stateid.Set.elements invalid);
  let s1,(s2,(s3,(s4,(s5,())))) = d_sentences doc (P(P(P(P(P(O)))))) in
  [%test_eq: sentence_id option] (Some s5.id) unchanged;
  let doc = Document.apply_text_edits doc [Document.range_of_id doc s3.id,""] in
  let unchanged, invalid, doc = Document.validate_document doc in
  let r1,(r2,(r3,(r4,()))) = d_sentences doc (P(P(P(P(O))))) in
  [%test_eq: sentence_id list] [s3.id;s4.id;s5.id] (Stateid.Set.elements invalid);
  [%test_eq: sentence_id option] (Some s2.id) unchanged;
  [%test_eq: sentence_id] s1.id r1.id;
  [%test_eq: sentence_id] s2.id r2.id

let %test_unit "document: delete line" = 
  let dm, _ = init_test_doc ~text:"Definition x:= 3. Lemma foo : x = 3. Proof. reflexitivity. Qed." in 
  let doc = DocumentManager.Internal.document dm in 
  let unchanged, invalid, doc = Document.validate_document doc in
  [%test_eq: sentence_id list] [] (Stateid.Set.elements invalid);
  let s1,(s2,(s3,(s4,(s5,())))) = d_sentences doc (P(P(P(P(P(O)))))) in
  let doc = Document.apply_text_edits doc [Document.range_of_id doc s5.id,""] in
  let unchanged, invalid, doc = Document.validate_document doc in 
  let sentences_id = Stateid.Set.of_list (List.map (Document.sentences doc) ~f:(fun s -> s.id)) in
  [%test_pred: sentence_id] (fun x -> not (Stateid.Set.mem x sentences_id)) s5.id;
  ()

let %test_unit "document: expand sentence" =
  let dm, _ = init_test_doc ~text:"Lemma foo : x = 3. M." in
  let doc = DocumentManager.Internal.document dm in
  let unchanged, invalid, doc = Document.validate_document doc in
  [%test_eq: sentence_id list] [] (Stateid.Set.elements invalid);
  let s1,(s2,()) = d_sentences doc (P(P(O))) in
  let range = Document.range_of_id doc s2.id in
  let new_range = Lsp.Types.Range.{ start = range.end_; end_ = range.end_ } in
  let doc = Document.apply_text_edits doc [new_range,"foo."] in
  let unchanged, invalid, doc = Document.validate_document doc in
  let r1,(r2,()) = d_sentences doc (P(P(O))) in
  [%test_eq: sentence_id] s1.id r1.id;
  ()