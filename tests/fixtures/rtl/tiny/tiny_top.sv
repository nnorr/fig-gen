// Tiny self-written fixture for the Verilator adapter tests.
// `ext_mem` is intentionally NOT defined anywhere: it exercises the generic
// auto-blackbox path. `s1_q`/`s2_q` form a 2-FF synchronizer into clk_b.

module tiny_top (
  input  logic       clk_a,
  input  logic       clk_b,
  input  logic       rst_n,
  input  logic [7:0] a,
  input  logic [7:0] b,
  input  logic       sel,
  output logic [7:0] y,
  output logic       flag_b
);
  logic [7:0] s0_q;
  logic [7:0] m;
  logic [7:0] rdata;
  logic [7:0] stage_q;
  logic       s1_q, s2_q;

  assign m = sel ? a : b;

  always_ff @(posedge clk_a or negedge rst_n) begin
    if (!rst_n) s0_q <= 8'h00;
    else        s0_q <= m ^ 8'h5a;
  end

  ext_mem u_mem (
    .CK  (clk_a),
    .ADR (s0_q[3:0]),
    .DI  (a),
    .DO  (rdata),
    .WE  (1'b0)
  );

  tiny_stage #(.W(8)) u_stage (
    .clk   (clk_a),
    .rst_n (rst_n),
    .d     (rdata),
    .q     (stage_q)
  );

  always_ff @(posedge clk_b) begin
    s1_q <= s0_q[0];
    s2_q <= s1_q;
  end

  assign y      = stage_q;
  assign flag_b = s2_q;
endmodule

module tiny_stage #(
  parameter int W = 4
) (
  input  logic         clk,
  input  logic         rst_n,
  input  logic [W-1:0] d,
  output logic [W-1:0] q
);
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) q <= '0;
    else        q <= d;
  end
endmodule
